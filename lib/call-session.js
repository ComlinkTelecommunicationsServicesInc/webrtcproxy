const Emitter = require('events');
const {
  makeRtpEngineOpts,
  removeWebrtcAttributes,
  makeModifyDialogOpts
} = require('./utils');
const { forwardInDialogRequests } = require('drachtio-fn-b2b-sugar');
const { parseUri, SipError } = require('drachtio-srf');
const config = require('config');
const debug = require('debug')('drachtio:rtpengine-webrtcproxy');
const calls = new Map();

const createHeaders = (registrar, callid) => {
  // check if we have a call-id / cseq that we used previously on a 407-challenged INVITE
  const obj = registrar.getNextCallIdAndCSeq(callid);
  if (obj) {
    registrar.removeTransaction(callid);
    return obj;
  }
  return { 'CSeq': '1 INVITE' };
};

const makeReplacesStr = (dlg) => {
  var s = '';
  if (dlg.type === 'uas') {
    s = encodeURIComponent(`${dlg.sip.callId};to-tag=${dlg.sip.localTag};from-tag=${dlg.sip.remoteTag}`);
  }
  else {
    s = encodeURIComponent(`${dlg.sip.callId};to-tag=${dlg.sip.remoteTag};from-tag=${dlg.sip.localTag}`);
  }
  return s;
};

class CallSession extends Emitter {
  constructor(req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = req.locals.logger;

    const { registrar } = req.srf.locals;
    this.registrar = registrar;
  }

  async connect() {
    const { protocol, source_address, uri } = this.req;
    this.logger.info(
      `received invite from ${protocol}/${source_address}:${uri} with request uri ${uri}`);

    const { callDirection, remoteUri, callid } = this.req.locals;
    const parsedUri = parseUri(uri);
    const trunk = parsedUri.host;
    let inviteSent;

    try {
      const headers = createHeaders(this.registrar, callid);

      // check to see if we are sending to a trunk that we hold sip credentials for
      let t;
      if (trunk && config.has('credentials')) {
        t = config.get('credentials').find((c) => c.trunk === trunk);
        if (t) this.logger.info(`we will be handling auth challenges for this call to ${trunk}`);
      }

      const callOpts = {
        headers,
        ...(t && { auth: t.auth }),
        localSdpB: this.req.sdp,
        proxyRequestHeaders: [
          'from',
          'to',
          'proxy-authorization',
          'authorization',
          'supported',
          'allow',
          'content-type',
          'user-agent',
          'Diversion'
        ],
        proxyResponseHeaders: [
          'proxy-authenticate',
          'www-authenticate',
          'accept',
          'allow',
          'allow-events'
        ]
      };

      this.logger.info({ callOpts }, 'sending INVITE to B');
      const { uas, uac } = await this.srf.createB2BUA(this.req, this.res, remoteUri, {
        ...callOpts,
        localSdpA: async (sdp, res) => {
          return sdp;
        }
      }, {
        cbRequest: (err, req) => inviteSent = req
      });

      // successfully connected
      this._setHandlers({ uas, uac });
    } catch (err) {
      if (err instanceof SipError && [401, 407].includes(err.status)) {
        this.logger.info(`invite challenged with ${err.status}`);
        this.registrar.addTransaction({
          aCallId: callid,
          bCallId: inviteSent.get('Call-Id'),
          bCseq: inviteSent.get('CSeq')
        });
      }
      else if (487 === err.status) {
        this.logger.info('caller hung up');
      }
      else {
        this.logger.error({ err }, `Error connecting call with callID ${callid}, ${err}`);
        this.res.send(503);
      }
    }
  }

  _dumpKeys() {

    for (var [key, value] of calls.entries()) {
      this.logger.info({ key, value }, '_dumpKeys');
    }
  }

  _setHandlers({ uas, uac }) {
    this.emit('connected');
    this.uas = uas;
    this.uac = uac;

    const key = makeReplacesStr(uas);
    const value = makeReplacesStr(uac);
    calls.set(key, value);
    this.logger.info(`after adding call there are now ${calls.size} calls in progress`);
    [uas, uac].forEach((dlg) => {
      dlg.on('destroy', async () => {
        const other = dlg.other;
        try {
          await other.destroy();
        } catch (err) { }

        /* de-link the 2 Dialogs for GC */
        dlg.removeAllListeners();
        other.removeAllListeners();
        dlg.other = null;
        other.other = null;

        calls.delete(key);
        this.logger.info(`call ended with normal termination, there are ${calls.size} active calls`);
        this.srf.endSession(this.req);
      });
    });

    uas.on('refer', this._handleRefer.bind(this, uas));
    uac.on('refer', this._handleRefer.bind(this, uac));

    uas.on('info', this._handleInfo.bind(this, uas));
    uac.on('info', this._handleInfo.bind(this, uac));

    uas.on('modify', this._handleReinvite.bind(this, uas));
    uac.on('modify', this._handleReinvite.bind(this, uac));

    // default forwarding of other request types
    forwardInDialogRequests(uas, ['notify', 'options', 'message']);
  }

  async _handleReinvite(dlg, req, res) {
    try {
      const newsdp = await dlg.other.modify(req.body);
      res.send(200, { body: newsdp });
    } catch (err) {
      this.logger.error({ err }, 'Error handling reinvite');
    }
  }

  async _handleInfo(dlg, req, res) {
    this.logger.info(`received info with content-type: ${req.get('Content-Type')}`);

    try {
      const immutableHdrs = ['via', 'from', 'to', 'call-id', 'cseq', 'max-forwards', 'content-length'];
      const headers = {};
      Object.keys(req.headers).forEach((h) => {
        if (!immutableHdrs.includes(h)) headers[h] = req.headers[h];
      });
      const response = await dlg.other.request({ method: 'INFO', headers, body: req.body });
      const responseHeaders = {};
      if (response.has('Content-Type')) {
        Object.assign(responseHeaders, { 'Content-Type': response.get('Content-Type') });
      }
      res.send(response.status, { headers: responseHeaders, body: response.body });
    } catch (err) {
      this.logger.info({ err }, `Error handing INFO request on ${dlg.type} leg`);
    }
  }

  async _handleRefer(dlg, req, res) {
    this.logger.info('Received Refer on ', dlg.type);

    let referTo = req.get('Refer-To');
    const arr = /(.*)Replaces=(.*)>/.exec(referTo);

    // for attended transfer: fixup the Replaces part of the Refer-To header
    if (arr) {
      const key = arr[2];
      if (calls.has(key)) {
        referTo = `${arr[1]}Replaces=${calls.get(key)}>`;
      }
      else {
        this.logger.error(
          `attended transfer for callID ${req.get('Call-Id')} but we can't find ${key} in ${calls.size} entries`);
      }
    }

    try {
      const reqHeaders = req.get('Authorization') ?
        { 'Authorization': req.get('Authorization'), 'Refer-To': referTo, 'Referred-By': req.get('Referred-By') } :
        { 'Refer-To': referTo, 'Referred-By': req.get('Referred-By') };
      const response = await dlg.other.request({
        method: 'REFER',
        headers: reqHeaders
      });
      if (response.status === 401) {
        const resHeaders = { 'headers': { 'www-authenticate': response.get('www-authenticate') } };
        res.send(response.status, response.reason, resHeaders);
      }
      else {
        res.send(response.status);
      }
    } catch (err) {
      this.logger.error(err, `Error handling REFER for callID ${req.get('Call-Id')}`);
    }
  }

  /**
   * Handle ACK for late offer reInvite
   * @param {*} dlg     dialog receiving the re-INVITE
   * @param {*} ack     function to send the ACK w/sdp
   * @param {*} offerSdp sdp sent in the 200 OK
   * @param {*} req     sip request

   */
  async _handleAck(dlg, ack, offerSdp, req) {
    this.logger.info('Received ACK with late offer: ', offerSdp);

    try {
      let fromTag = dlg.other.sip.remoteTag;
      let toTag = dlg.other.sip.localTag;
      if (dlg.type === 'uac') {
        fromTag = dlg.sip.localTag;
        toTag = dlg.sip.remoteTag;
      }
      const offerMedia = dlg.type === 'uas' ? this.rtpEngineOpts.uas.mediaOpts : this.rtpEngineOpts.uac.mediaOpts;
      let answerMedia = dlg.type === 'uas' ? this.rtpEngineOpts.uac.mediaOpts : this.rtpEngineOpts.uas.mediaOpts;
      //if uas is webrtc facing, we need to keep that side as the active ssl role, so use passive in the ACK sdp
      if (dlg.type === 'uas' && JSON.stringify(answerMedia).includes('SAVPF')) {
        let mediaStringified = JSON.stringify(answerMedia);
        mediaStringified = mediaStringified.replace('SAVPF\"', 'SAVPF\",\"DTLS\":\"passive\"');
        answerMedia = JSON.parse(mediaStringified);
      }

      const optsOffer = {
        ...this.rtpEngineOpts.common,
        ...offerMedia,
        'from-tag': fromTag,
        'to-tag': toTag,
        sdp: offerSdp
      };
      //send an offer first so that rtpEngine knows that DTLS fingerprint needs to be in the answer sdp.
      const response = await this.offer(optsOffer);
      if ('ok' !== response.result) {
        throw new Error(`_handleAck: rtpengine failed: offer: ${JSON.stringify(response)}`);
      }

      const optsAnswer = {
        ...this.rtpEngineOpts.common,
        ...answerMedia,
        'from-tag': fromTag,
        'to-tag': toTag,
        sdp: req.body
      };
      const ackResponse = await this.answer(optsAnswer);
      if ('ok' !== ackResponse.result) {
        throw new Error(`_handleAck ${req.get('Call-Id')}: rtpengine failed: answer: ${JSON.stringify(ackResponse)}`);
      }
      if (JSON.stringify(answerMedia).includes('ICE\":\"remove')) {
        ackResponse.sdp = removeWebrtcAttributes(ackResponse.sdp);
      }
      //send the ACK with sdp
      ack(ackResponse.sdp);

    } catch (err) {
      this.logger.error(err, `Error handling ACK with callId ${req.get('Call-Id')}`);
    }
  }
}


module.exports = CallSession;
