const { forwardInDialogRequests } = require('drachtio-fn-b2b-sugar');

const parseUri = require('drachtio-srf').parseUri ;
const SipError = require('drachtio-srf').SipError;

class Optionser {

  constructor(logger) {
    this._logger = logger;
  }

  get logger() {
    return this._logger;
  }

  start(srf) {
    srf.options(async (req, res) => {

      this.logger.info(`UAC options: ${req.protocol}/${req.source_address}:${req.source_port}`) ;

      // only registered users are allowed to subscribe
      const { callDirection, remoteUri, callid } = req.locals;

      // check if we have a call-id / cseq that we used previously on a 401-challenged SUBSCRIBE
      const headers = {'CSeq': '1 OPTIONS'} ;

      srf.request({
        uri: remoteUri || req.uri,
        method: req.method,
        headers
      }, (err, request) => {
        if (err) {
          res.send(503);
          return this.logger.error(`Error forwarding OPTIONS to: ${remoteUri.host}; err: ${err}`);
        }
        request.on('response', (response) => {
          res.send(response.status, response.reason) ;
        });
      });
    });
  }
}

module.exports = Optionser ;
