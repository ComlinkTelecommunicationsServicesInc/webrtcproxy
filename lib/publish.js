const { forwardInDialogRequests } = require('drachtio-fn-b2b-sugar');

const parseUri = require('drachtio-srf').parseUri ;
const SipError = require('drachtio-srf').SipError;

class Publish {

  constructor(logger) {
    this._logger = logger;
  }

  get logger() {
    return this._logger;
  }

  start(srf, registrar) {
    srf.publish(async (req, res) => {

      this.logger.info(`UAC Publish: ${req.protocol}/${req.source_address}:${req.source_port}`) ;

      // only registered users are allowed to publish
      const { callDirection, remoteUri, callid } = req.locals;

      // check if we have a call-id / cseq that we used previously on a 401-challenged SUBSCRIBE
      const headers = {} ;
      const obj = registrar.getNextCallIdAndCSeq(callid) ;
      if (obj) {
        Object.assign(headers, obj) ;
        registrar.removeTransaction(callid);
      }
      else {
        Object.assign(headers, {'CSeq': '1 PUBLISH'}) ;
      }

      ['from', 'to', 'authorization', 'supported', 'allow', 'user-agent', 'content-type'].forEach((hdr) => {
        if (req.has(hdr)) headers[hdr] = req.get(hdr) ;
      }) ;

      srf.request({
        uri: req.uri,
        method: req.method,
        headers,
        body: req.body
      }, (err, request) => {
        if (err) {
          return logger.error(`Error forwarding PUBLISH to: ${uri.host}; err: ${err}`);
        }
        request.on('response', (response) => {
          const headers = {} ;
          ['www-authenticate'].forEach((hdr) => {
            if (response.has(hdr)) headers[hdr] = response.get(hdr);
          });

          res.send(response.status, response.reason, {headers}) ;

          if (200 === response.status || 202 === response.status) {
            registrar.removeTransaction(req.get('call-id')) ;
          } else if ([401, 407].includes(response.status)) {
            registrar.addTransaction({
              aCallId: callid,
              bCallId: response.get('Call-Id'),
              bCseq: response.get('CSeq')
            }) ;
          }
        });
      });
    });
  }
}

module.exports = Publish ;
