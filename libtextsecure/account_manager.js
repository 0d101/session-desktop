/* global
  window,
  textsecure,
  libsignal,
  libloki,
  libsession,
  lokiFileServerAPI,
  mnemonic,
  btoa,
  getString,
  Event,
  dcodeIO,
  StringView,
  log,
  Event,
  ConversationController,
  Whisper
*/

/* eslint-disable more/no-then */
/* eslint-disable no-unused-vars */
/* eslint-disable no-await-in-loop */

// eslint-disable-next-line func-names
(function() {
  window.textsecure = window.textsecure || {};

  const ARCHIVE_AGE = 7 * 24 * 60 * 60 * 1000;

  function AccountManager(username, password) {
    this.pending = Promise.resolve();
  }

  function getNumber(numberId) {
    if (!numberId || !numberId.length) {
      return numberId;
    }

    const parts = numberId.split('.');
    if (!parts.length) {
      return numberId;
    }

    return parts[0];
  }

  AccountManager.prototype = new textsecure.EventTarget();
  AccountManager.prototype.extend({
    constructor: AccountManager,
    registerSingleDevice(mnemonic, mnemonicLanguage, profileName) {
      const createAccount = this.createAccount.bind(this);
      const clearSessionsAndPreKeys = this.clearSessionsAndPreKeys.bind(this);
      const generateKeys = this.generateKeys.bind(this, 0);
      const confirmKeys = this.confirmKeys.bind(this);
      const registrationDone = this.registrationDone.bind(this);
      let generateKeypair;
      if (mnemonic) {
        generateKeypair = () => {
          let seedHex = window.mnemonic.mn_decode(mnemonic, mnemonicLanguage);
          // handle shorter than 32 bytes seeds
          const privKeyHexLength = 32 * 2;
          if (seedHex.length !== privKeyHexLength) {
            seedHex = seedHex.concat('0'.repeat(32));
            seedHex = seedHex.substring(0, privKeyHexLength);
          }
          const seed = dcodeIO.ByteBuffer.wrap(seedHex, 'hex').toArrayBuffer();
          return window.sessionGenerateKeyPair(seed);
        };
      } else {
        generateKeypair = libsignal.KeyHelper.generateIdentityKeyPair;
      }
      return this.queueTask(() =>
        generateKeypair().then(async identityKeyPair =>
          createAccount(identityKeyPair)
            .then(() => this.saveRecoveryPhrase(mnemonic))
            .then(clearSessionsAndPreKeys)
            .then(generateKeys)
            .then(confirmKeys)
            .then(() => {
              const pubKeyString = StringView.arrayBufferToHex(
                identityKeyPair.pubKey
              );
              registrationDone(pubKeyString, profileName);
            })
        )
      );
    },
    rotateSignedPreKey() {
      return this.queueTask(() => {
        const signedKeyId = textsecure.storage.get('signedKeyId', 1);
        if (typeof signedKeyId !== 'number') {
          throw new Error('Invalid signedKeyId');
        }

        const store = textsecure.storage.protocol;
        const { cleanSignedPreKeys } = this;

        return store
          .getIdentityKeyPair()
          .then(
            identityKey =>
              libsignal.KeyHelper.generateSignedPreKey(
                identityKey,
                signedKeyId
              ),
            () => {
              // We swallow any error here, because we don't want to get into
              //   a loop of repeated retries.
              window.log.error(
                'Failed to get identity key. Canceling key rotation.'
              );
            }
          )
          .then(res => {
            if (!res) {
              return null;
            }
            window.log.info('Saving new signed prekey', res.keyId);
            return Promise.all([
              textsecure.storage.put('signedKeyId', signedKeyId + 1),
              store.storeSignedPreKey(
                res.keyId,
                res.keyPair,
                undefined,
                res.signature
              ),
            ])
              .then(() => {
                const confirmed = true;
                window.log.info('Confirming new signed prekey', res.keyId);
                return Promise.all([
                  textsecure.storage.remove('signedKeyRotationRejected'),
                  store.storeSignedPreKey(
                    res.keyId,
                    res.keyPair,
                    confirmed,
                    res.signature
                  ),
                ]);
              })
              .then(() => cleanSignedPreKeys());
          })
          .catch(e => {
            window.log.error(
              'rotateSignedPrekey error:',
              e && e.stack ? e.stack : e
            );

            if (
              e instanceof Error &&
              e.name === 'HTTPError' &&
              e.code >= 400 &&
              e.code <= 599
            ) {
              const rejections =
                1 + textsecure.storage.get('signedKeyRotationRejected', 0);
              textsecure.storage.put('signedKeyRotationRejected', rejections);
              window.log.error(
                'Signed key rotation rejected count:',
                rejections
              );
            } else {
              throw e;
            }
          });
      });
    },
    queueTask(task) {
      const taskWithTimeout = textsecure.createTaskWithTimeout(task);
      this.pending = this.pending.then(taskWithTimeout, taskWithTimeout);

      return this.pending;
    },
    cleanSignedPreKeys() {
      const MINIMUM_KEYS = 3;
      const store = textsecure.storage.protocol;
      return store.loadSignedPreKeys().then(allKeys => {
        allKeys.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
        allKeys.reverse(); // we want the most recent first
        let confirmed = allKeys.filter(key => key.confirmed);
        const unconfirmed = allKeys.filter(key => !key.confirmed);

        const recent = allKeys[0] ? allKeys[0].keyId : 'none';
        const recentConfirmed = confirmed[0] ? confirmed[0].keyId : 'none';
        window.log.info(`Most recent signed key: ${recent}`);
        window.log.info(`Most recent confirmed signed key: ${recentConfirmed}`);
        window.log.info(
          'Total signed key count:',
          allKeys.length,
          '-',
          confirmed.length,
          'confirmed'
        );

        let confirmedCount = confirmed.length;

        // Keep MINIMUM_KEYS confirmed keys, then drop if older than a week
        confirmed = confirmed.forEach((key, index) => {
          if (index < MINIMUM_KEYS) {
            return;
          }
          const createdAt = key.created_at || 0;
          const age = Date.now() - createdAt;

          if (age > ARCHIVE_AGE) {
            window.log.info(
              'Removing confirmed signed prekey:',
              key.keyId,
              'with timestamp:',
              createdAt
            );
            store.removeSignedPreKey(key.keyId);
            confirmedCount -= 1;
          }
        });

        const stillNeeded = MINIMUM_KEYS - confirmedCount;

        // If we still don't have enough total keys, we keep as many unconfirmed
        // keys as necessary. If not necessary, and over a week old, we drop.
        unconfirmed.forEach((key, index) => {
          if (index < stillNeeded) {
            return;
          }

          const createdAt = key.created_at || 0;
          const age = Date.now() - createdAt;
          if (age > ARCHIVE_AGE) {
            window.log.info(
              'Removing unconfirmed signed prekey:',
              key.keyId,
              'with timestamp:',
              createdAt
            );
            store.removeSignedPreKey(key.keyId);
          }
        });
      });
    },
    async createAccount(identityKeyPair, userAgent, readReceipts) {
      const signalingKey = libsignal.crypto.getRandomBytes(32 + 20);
      let password = btoa(getString(libsignal.crypto.getRandomBytes(16)));
      password = password.substring(0, password.length - 2);
      const registrationId = libsignal.KeyHelper.generateRegistrationId();

      await Promise.all([
        textsecure.storage.remove('identityKey'),
        textsecure.storage.remove('signaling_key'),
        textsecure.storage.remove('password'),
        textsecure.storage.remove('registrationId'),
        textsecure.storage.remove('number_id'),
        textsecure.storage.remove('device_name'),
        textsecure.storage.remove('userAgent'),
        textsecure.storage.remove('read-receipt-setting'),
        textsecure.storage.remove('typing-indicators-setting'),
        textsecure.storage.remove('regionCode'),
      ]);

      // update our own identity key, which may have changed
      // if we're relinking after a reinstall on the master device
      const pubKeyString = StringView.arrayBufferToHex(identityKeyPair.pubKey);
      await textsecure.storage.protocol.saveIdentityWithAttributes(
        pubKeyString,
        {
          id: pubKeyString,
          publicKey: identityKeyPair.pubKey,
          firstUse: true,
          timestamp: Date.now(),
          verified: textsecure.storage.protocol.VerifiedStatus.VERIFIED,
          nonblockingApproval: true,
        }
      );

      await textsecure.storage.put('identityKey', identityKeyPair);
      await textsecure.storage.put('signaling_key', signalingKey);
      await textsecure.storage.put('password', password);
      await textsecure.storage.put('registrationId', registrationId);
      if (userAgent) {
        await textsecure.storage.put('userAgent', userAgent);
      }

      await textsecure.storage.put(
        'read-receipt-setting',
        Boolean(readReceipts)
      );

      // Enable typing indicators by default
      await textsecure.storage.put('typing-indicators-setting', Boolean(true));

      await textsecure.storage.user.setNumberAndDeviceId(pubKeyString, 1);
      await textsecure.storage.put('regionCode', null);
    },
    async clearSessionsAndPreKeys() {
      const store = textsecure.storage.protocol;

      window.log.info('clearing all sessions, prekeys, and signed prekeys');
      await Promise.all([
        store.clearContactPreKeysStore(),
        store.clearContactSignedPreKeysStore(),
        store.clearSessionStore(),
      ]);
      // During secondary device registration we need to keep our prekeys sent
      // to other pubkeys
      if (textsecure.storage.get('secondaryDeviceStatus') !== 'ongoing') {
        await Promise.all([
          store.clearPreKeyStore(),
          store.clearSignedPreKeysStore(),
        ]);
      }
    },
    // Takes the same object returned by generateKeys
    async confirmKeys(keys) {
      const store = textsecure.storage.protocol;
      const key = keys.signedPreKey;
      const confirmed = true;

      window.log.info('confirmKeys: confirming key', key.keyId);
      await store.storeSignedPreKey(
        key.keyId,
        key.keyPair,
        confirmed,
        key.signature
      );
    },
    generateKeys(count, providedProgressCallback) {
      const progressCallback =
        typeof providedProgressCallback === 'function'
          ? providedProgressCallback
          : null;
      const startId = textsecure.storage.get('maxPreKeyId', 1);
      const signedKeyId = textsecure.storage.get('signedKeyId', 1);

      if (typeof startId !== 'number') {
        throw new Error('Invalid maxPreKeyId');
      }
      if (typeof signedKeyId !== 'number') {
        throw new Error('Invalid signedKeyId');
      }

      const store = textsecure.storage.protocol;
      return store.getIdentityKeyPair().then(identityKey => {
        const result = { preKeys: [], identityKey: identityKey.pubKey };
        const promises = [];

        for (let keyId = startId; keyId < startId + count; keyId += 1) {
          promises.push(
            libsignal.KeyHelper.generatePreKey(keyId).then(res => {
              store.storePreKey(res.keyId, res.keyPair);
              result.preKeys.push({
                keyId: res.keyId,
                publicKey: res.keyPair.pubKey,
              });
              if (progressCallback) {
                progressCallback();
              }
            })
          );
        }

        promises.push(
          libsignal.KeyHelper.generateSignedPreKey(
            identityKey,
            signedKeyId
          ).then(res => {
            store.storeSignedPreKey(
              res.keyId,
              res.keyPair,
              undefined,
              res.signature
            );
            result.signedPreKey = {
              keyId: res.keyId,
              publicKey: res.keyPair.pubKey,
              signature: res.signature,
              keyPair: res.keyPair,
            };
          })
        );

        textsecure.storage.put('maxPreKeyId', startId + count);
        textsecure.storage.put('signedKeyId', signedKeyId + 1);
        return Promise.all(promises).then(() =>
          // This is primarily for the signed prekey summary it logs out
          this.cleanSignedPreKeys().then(() => result)
        );
      });
    },
    async generateMnemonic(language = 'english') {
      // Note: 4 bytes are converted into 3 seed words, so length 12 seed words
      // (13 - 1 checksum) are generated using 12 * 4 / 3 = 16 bytes.
      const seedSize = 16;
      const seed = window.Signal.Crypto.getRandomBytes(seedSize);
      const hex = StringView.arrayBufferToHex(seed);
      return mnemonic.mn_encode(hex, language);
    },
    getCurrentRecoveryPhrase() {
      return textsecure.storage.get('mnemonic');
    },
    saveRecoveryPhrase(mnemonic) {
      return textsecure.storage.put('mnemonic', mnemonic);
    },
    async registrationDone(number, displayName) {
      window.log.info('registration done');

      if (!textsecure.storage.get('secondaryDeviceStatus')) {
        // We have registered as a primary device
        textsecure.storage.put('primaryDevicePubKey', number);
      }
      // Ensure that we always have a conversation for ourself
      const conversation = await ConversationController.getOrCreateAndWait(
        number,
        'private'
      );
      await conversation.setLokiProfile({ displayName });

      this.dispatchEvent(new Event('registration'));
    },
    async requestPairing(primaryDevicePubKey) {
      // throws if invalid
      this.validatePubKeyHex(primaryDevicePubKey);
      // we need a conversation for sending a message
      await ConversationController.getOrCreateAndWait(
        primaryDevicePubKey,
        'private'
      );
      const ourPubKey = textsecure.storage.user.getNumber();
      if (primaryDevicePubKey === ourPubKey) {
        throw new Error('Cannot request to pair with ourselves');
      }
      const requestSignature = await libloki.crypto.generateSignatureForPairing(
        primaryDevicePubKey,
        libloki.crypto.PairingType.REQUEST
      );

      const primaryDevice = new libsession.Types.PubKey(primaryDevicePubKey);

      const requestPairingMessage = new window.libsession.Messages.Outgoing.DeviceLinkRequestMessage(
        {
          timestamp: Date.now(),
          primaryDevicePubKey,
          secondaryDevicePubKey: ourPubKey,
          requestSignature: new Uint8Array(requestSignature),
        }
      );
      await window.libsession
        .getMessageQueue()
        .send(primaryDevice, requestPairingMessage);
    },
    async authoriseSecondaryDevice(secondaryDeviceStr) {
      const ourPubKey = textsecure.storage.user.getNumber();
      if (secondaryDeviceStr === ourPubKey) {
        throw new Error(
          'Cannot register primary device pubkey as secondary device'
        );
      }
      const secondaryDevicePubKey = libsession.Types.PubKey.from(
        secondaryDeviceStr
      );

      if (!secondaryDevicePubKey) {
        window.console.error(
          'Invalid secondary pubkey on authoriseSecondaryDevice'
        );

        return;
      }
      const grantSignature = await libloki.crypto.generateSignatureForPairing(
        secondaryDeviceStr,
        libloki.crypto.PairingType.GRANT
      );
      const authorisations = await libsession.Protocols.MultiDeviceProtocol.getPairingAuthorisations(
        secondaryDeviceStr
      );
      const existingAuthorisation = authorisations.find(
        pairing => pairing.secondaryDevicePubKey === secondaryDeviceStr
      );
      if (!existingAuthorisation) {
        throw new Error(
          'authoriseSecondaryDevice: request signature missing from database!'
        );
      }
      const { requestSignature } = existingAuthorisation;
      const authorisation = {
        primaryDevicePubKey: ourPubKey,
        secondaryDevicePubKey: secondaryDeviceStr,
        requestSignature,
        grantSignature,
      };

      // Update authorisation in database with the new grant signature
      await libsession.Protocols.MultiDeviceProtocol.savePairingAuthorisation(
        authorisation
      );
      const ourConversation = await ConversationController.getOrCreateAndWait(
        ourPubKey,
        'private'
      );

      // We need to send the our profile to the secondary device
      const lokiProfile = ourConversation.getOurProfile();

      // Try to upload to the file server and then send a message
      try {
        await lokiFileServerAPI.updateOurDeviceMapping();
        const requestPairingMessage = new libsession.Messages.Outgoing.DeviceLinkGrantMessage(
          {
            timestamp: Date.now(),
            primaryDevicePubKey: ourPubKey,
            secondaryDevicePubKey: secondaryDeviceStr,
            requestSignature: new Uint8Array(requestSignature),
            grantSignature: new Uint8Array(grantSignature),
            lokiProfile,
          }
        );
        await libsession
          .getMessageQueue()
          .send(secondaryDevicePubKey, requestPairingMessage);
      } catch (e) {
        log.error(
          'Failed to authorise secondary device: ',
          e && e.stack ? e.stack : e
        );
        // File server upload failed or message sending failed, we should rollback changes
        await libsession.Protocols.MultiDeviceProtocol.removePairingAuthorisations(
          secondaryDeviceStr
        );
        await lokiFileServerAPI.updateOurDeviceMapping();
        throw e;
      }

      // Send sync messages
      // bad hack to send sync messages when secondary device is ready to process them
      setTimeout(async () => {
        const conversations = window.getConversations().models;
        await textsecure.messaging.sendGroupSyncMessage(conversations);
        await textsecure.messaging.sendOpenGroupsSyncMessage(conversations);
        await textsecure.messaging.sendContactSyncMessage();
      }, 5000);
    },
    validatePubKeyHex(pubKey) {
      const c = new Whisper.Conversation({
        id: pubKey,
        type: 'private',
      });
      const validationError = c.validateNumber();
      if (validationError) {
        throw new Error(validationError);
      }
    },
  });
  textsecure.AccountManager = AccountManager;
})();
