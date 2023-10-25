const assert = require('assert');
const Srf = require('drachtio-srf') ;
const srf = new Srf() ;
const logger = require('pino')();
const Register = require('./lib/register');
const Registrar = require('./lib/registrar');
const Subscriber = require('./lib/subscriber');
const registrar = new Registrar(logger) ;
const register = new Register(logger) ;
const subscriber = new Subscriber(logger);
const config = require('config') ;

srf.locals = {
  ...srf.locals,
  registrar,
};

srf.connect(config.get('drachtio'))
  .on('connect', (err, hostport) => {
    console.log(`connected to drachtio listening for SIP on hostport ${hostport}`) ;
  })
  .on('error', (err) => {
    console.error(`Error connecting to drachtio server: ${err.message}`) ;
  });

const {
  initLocals,
  identifyCallDirection
} = require('./lib/middleware')(srf, logger);
const CallSession = require('./lib/call-session');

srf.use('invite', [initLocals, identifyCallDirection]);
srf.invite((req, res) => {
  const session = new CallSession(req, res);
  session.connect();
});

register.start(srf, registrar);
subscriber.start(srf, registrar);
