/*
 * GTalk integration tests use 2 test accounts.  Credentials for these accounts
 * are defined in gtalk_credentials.js.  To avoid flakiness, you should replace
 * the account credentials in gtalk_credentials.js with credentials from
 * accounts that only you are using.  See gtalk_credentials.js for more info.
 *
 * Possible flakiness in these tests may occur when using the default (shared)
 * accounts if:
 * - If multiple users run the tests at the same time, they may send messages
 *   to each other, rather than between the 2 social clients running in the
 *   same test
 * - If tests are run too frequently, GTalk may throttle messages sooner
 *   (return 503 "service unavailable")
 * To prevent flakiness, these tests should only be run by 1 person at a time
 * (per pair of tests accounts) with some time (rough estimate 10 minutes)
 * between each attempt.
 */


var REDIRECT_URL = 'http://localhost';
var CLIENT_ID =
    '746567772449-mv4h0e34orsf6t6kkbbht22t9otijip0.apps.googleusercontent.com';
var CLIENT_SECRET = 'M-EGTuFRaWLS5q_hygpJZMBu';

var OAuthView = function() {};
OAuthView.prototype.initiateOAuth = function(redirectURIs, continuation) {
  continuation({redirect: REDIRECT_URL, state: ''});
  return true;
};
OAuthView.prototype.launchAuthFlow = function(authUrl, stateObj, continuation) {
  if (!this.refreshToken) {
    continuation(undefined, 'No refreshToken set.');
    return;
  }
  return Helper.getAccessToken(this.refreshToken).then(function(accessToken) {
    continuation(REDIRECT_URL + '?access_token=' + accessToken);
  }).catch(function(e) {
    continuation(undefined, 'Failed to get access token');
  });
};

var Helper = {
  // Returns a Promise that fulfills with an access token.
  getAccessToken: function(refreshToken) {
    return new Promise(function(fulfill, resolve) {
      var data = 'refresh_token=' + refreshToken +
          '&client_id=' + CLIENT_ID +
          '&client_secret=' + CLIENT_SECRET +
          '&grant_type=refresh_token';
      var xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://www.googleapis.com/oauth2/v3/token', true);
      xhr.setRequestHeader('content-type', 'application/x-www-form-urlencoded');
      xhr.onload = function() {
        fulfill(JSON.parse(this.response).access_token);
      };
      xhr.send(data);
    });
  },
  // Sets up an onClientState listener and invokes the callback function
  // anytime a new client for the given userId appears as ONLINE.
  onClientOnline: function(socialClient, userId, callback) {
    socialClient.on('onClientState', function(clientState) {
      if (clientState.userId == userId &&
          clientState.status == 'ONLINE' &&
          !Helper.onlineClientIds[clientState.clientId]) {
        // Mark this client as online so we don't re-invoke the callback
        // extra times (e.g. when only lastUpdated has changed.)
        Helper.onlineClientIds[clientState.clientId] = true;
        callback(clientState);
      }
    });
  },
  onlineClientIds: {}
};  // end of Helper

describe('GTalk', function() {
  // Social interface objects, used for initializing social clients.
  var aliceSocialInterface;
  var bobSocialInterface;

  var aliceSocialClient;
  var bobSocialClient;

  var loginOpts = {
    agent: 'integration',
    version: '0.1',
    url: '',
    interactive: false,
    rememberLogin: false
  };

  // Message to be sent between peers.  If a unique message is not used,
  // messages from one persons test might interfere with another person who
  // is running the same tests at the same time.
  var uniqueMsg = Math.random().toString();

  beforeEach(function(done) {
    // Ensure that aliceSocialInterface and bobSocialInterface are set.
    var loadInterfaces = new Promise(function(fulfill, reject) {
      if (!aliceSocialInterface || !bobSocialInterface) {
        AliceOAuthView = function() {};
        AliceOAuthView.prototype = new OAuthView();
        AliceOAuthView.prototype.refreshToken = ALICE.REFRESH_TOKEN;
        BobOAuthView = function() {};
        BobOAuthView.prototype = new OAuthView();
        BobOAuthView.prototype.refreshToken = BOB.REFRESH_TOKEN;
        var alicePromise = freedom('scripts/dist/social.google.json',
            {oauth: [AliceOAuthView], debug: 'log'})
            .then(function(interface) {
          aliceSocialInterface = interface;
        });
        var bobPromise = freedom('scripts/dist/social.google.json',
            {oauth: [BobOAuthView], debug: 'log'})
            .then(function(interface) {
          bobSocialInterface = interface;
        }.bind(this));
        Promise.all([alicePromise, bobPromise]).then(fulfill);
      } else {
        fulfill();
      }
    }).then(function() {
      aliceSocialClient = aliceSocialInterface();
      bobSocialClient = bobSocialInterface();
      done();
    });
  });

  afterEach(function(done) {
    Helper.onlineClientIds = {};
    Promise.all([aliceSocialClient.logout(), bobSocialClient.logout()])
        .then(done);
  });

  it('Can login and logout', function(done) {
    aliceSocialClient.login(loginOpts).then(function(clientInfo) {
      expect(clientInfo.userId).toEqual(ALICE.EMAIL);
      expect(clientInfo.clientId).toEqual(ALICE.EMAIL + '/integration');
      expect(clientInfo.status).toEqual('ONLINE');
      done();
    });
  });

  // This test writes to ALICE.ANONYMIZED_ID and BOB.ANONYMIZED_ID.
  it('Peers can detect each other', function(done) {
    var aliceSawBob = new Promise(function(fulfill, reject) {
      aliceSocialClient.on('onUserProfile', function(userProfile) {
        if (userProfile.name == BOB.NAME) {
          BOB.ANONYMIZED_ID = userProfile.userId;
          fulfill();
        }
      });
      aliceSocialClient.login(loginOpts);
    });
    var bobSawAlice = new Promise(function(fulfill, reject) {
      bobSocialClient.on('onUserProfile', function(userProfile) {
        if (userProfile.name == ALICE.NAME) {
          ALICE.ANONYMIZED_ID = userProfile.userId;
          fulfill();
        }
      });
      bobSocialClient.login(loginOpts);
    });
    Promise.all([aliceSawBob, bobSawAlice]).then(done);
  });

  it('Can send messages', function(done) {
    // Setup a listener to send Bob messages when he is online
    Helper.onClientOnline(
        aliceSocialClient, BOB.ANONYMIZED_ID,
        function(clientState) {
      aliceSocialClient.sendMessage(clientState.clientId, uniqueMsg);
    });

    // Login as Alice.
    aliceSocialClient.login(loginOpts).then(function(aliceClientInfo) {
      // Next login as Bob and monitor for message.
      bobSocialClient.on('onMessage', function(messageData) {
        if (messageData.from.userId == ALICE.ANONYMIZED_ID &&
            messageData.message.substr(0, uniqueMsg.length) == uniqueMsg) {
          done();
        }
      });
      bobSocialClient.login(loginOpts);
    });
  });

  // We should be able to send 8 messages per second from one peer to another
  // without being throttled by GTalk (i.e. we should not get 503 "service
  // unavailable" errors).
  it('Can send 8 messages per second', function(done) {
    var TOTAL_MESSAGES = 8;
    // We should wait 10ms longer than the message batching frequency (100ms)
    // to ensure that every message is sent individually.
    var MESSAGE_FREQUENCY = 110;

    // Setup a listener to send Bob messages when he is online
    Helper.onClientOnline(
        aliceSocialClient, BOB.ANONYMIZED_ID,
        function(clientState) {
      var sentMessageCount = 0;
      for (var i = 1; i <= TOTAL_MESSAGES; ++i) {
        setTimeout(function() {
          aliceSocialClient.sendMessage(
              clientState.clientId, uniqueMsg + ':' + sentMessageCount);
          ++sentMessageCount;
        }, MESSAGE_FREQUENCY * i);
      }
    });

    // Login as Alice.
    aliceSocialClient.login(loginOpts).then(function(aliceClientInfo) {
      // Next login as Bob and monitor for messages.
      var receivedMessageCount = 0;
      bobSocialClient.on('onMessage', function(messageData) {
        if (messageData.from.userId == ALICE.ANONYMIZED_ID &&
            messageData.message.substr(0, uniqueMsg.length) == uniqueMsg) {
          // Keep this trace so we know how many messages are received
          // in case of failure.
          expect(messageData.message).toEqual(
              uniqueMsg + ':' + receivedMessageCount);
          ++receivedMessageCount;
          if (receivedMessageCount == TOTAL_MESSAGES) {
            done();
          }
        }
      });
      bobSocialClient.login(loginOpts);
    });
  });
});
