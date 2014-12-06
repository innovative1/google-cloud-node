/**
 * Copyright 2014 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*global describe, it, beforeEach */

'use strict';

var assert = require('assert');
var Bucket = require('../../lib/storage/bucket.js');
var crc = require('fast-crc32c');
var crypto = require('crypto');
var duplexify = require('duplexify');
var extend = require('extend');
var nodeutil = require('util');
var request = require('request');
var stream = require('stream');
var through = require('through2');
var url = require('url');
var util = require('../../lib/common/util');

var readableStream;
var writableStream;
function FakeDuplexify() {
  if (!(this instanceof FakeDuplexify)) {
    return new FakeDuplexify();
  }
  duplexify.call(this);
  this.setReadable = function(setReadableStream) {
    readableStream = setReadableStream;
  };
  this.setWritable = function(setWritableStream) {
    writableStream = setWritableStream;
  };
}
nodeutil.inherits(FakeDuplexify, duplexify);

var makeWritableStream_Override;
var fakeUtil = extend({}, util, {
  makeWritableStream: function() {
    var args = [].slice.call(arguments);
    (makeWritableStream_Override || util.makeWritableStream).apply(null, args);
    makeWritableStream_Override = null;
  }
});

var request_Cached = request;
var request_Override;

function fakeRequest() {
  var args = [].slice.apply(arguments);
  var results = (request_Override || request_Cached).apply(null, args);
  request_Override = null;
  return results;
}

var configStoreData = {};
function FakeConfigStore() {
  this.del = function(key) {
    delete configStoreData[key];
  };

  this.get = function(key) {
    return configStoreData[key];
  };

  this.set = function(key, value) {
    configStoreData[key] = value;
  };
}

var File = require('sandboxed-module')
  .require('../../lib/storage/file.js', {
    requires: {
      configstore: FakeConfigStore,
      duplexify: FakeDuplexify,
      request: fakeRequest,
      '../common/util': fakeUtil
    }
  });

describe('File', function() {
  var FILE_NAME = 'file-name.png';
  var options = {
    makeAuthorizedRequest_: function(req, callback) {
      (callback.onAuthorized || callback)(null, req);
    }
  };
  var bucket = new Bucket(options, 'bucket-name');
  var file;
  var directoryFile;

  beforeEach(function() {
    file = new File(bucket, FILE_NAME);
    file.makeReq_ = util.noop;

    directoryFile = new File(bucket, 'directory/file.jpg');
    directoryFile.makeReq_ = util.noop;
  });

  describe('initialization', function() {
    it('should throw if no name is provided', function() {
      assert.throws(function() {
        new File(bucket);
      }, /A file name must be specified/);
    });

    it('should assign file name', function() {
      assert.equal(file.name, FILE_NAME);
    });

    it('should assign metadata if provided', function() {
      var metadata = { a: 'b', c: 'd' };
      var newFile = new File(bucket, FILE_NAME, metadata);
      assert.deepEqual(newFile.metadata, metadata);
    });
  });

  describe('copy', function() {
    it('should throw if no destination is provided', function() {
      assert.throws(function() {
        file.copy();
      }, /should have a name/);
    });

    it('should URI encode file names', function(done) {
      var newFile = new File(bucket, 'nested/file.jpg');

      var expectedPath =
        util.format('/o/{srcName}/copyTo/b/{destBucket}/o/{destName}', {
          srcName: encodeURIComponent(directoryFile.name),
          destBucket: file.bucket.name,
          destName: encodeURIComponent(newFile.name)
        });

      directoryFile.makeReq_ = function(method, path) {
        assert.equal(path, expectedPath);
        done();
      };

      directoryFile.copy(newFile);
    });

    describe('destination types', function() {
      function assertPathEquals(file, expectedPath, callback) {
        file.makeReq_ = function(method, path) {
          assert.equal(path, expectedPath);
          callback();
        };
      }

      it('should allow a string', function(done) {
        var newFileName = 'new-file-name.png';
        var expectedPath =
          util.format('/o/{srcName}/copyTo/b/{destBucket}/o/{destName}', {
            srcName: file.name,
            destBucket: file.bucket.name,
            destName: newFileName
          });
        assertPathEquals(file, expectedPath, done);
        file.copy(newFileName);
      });

      it('should allow a Bucket', function(done) {
        var newBucket = new Bucket({}, 'new-bucket');
        var expectedPath =
          util.format('/o/{srcName}/copyTo/b/{destBucket}/o/{destName}', {
            srcName: file.name,
            destBucket: newBucket.name,
            destName: file.name
          });
        assertPathEquals(file, expectedPath, done);
        file.copy(newBucket);
      });

      it('should allow a File', function(done) {
        var newBucket = new Bucket({}, 'new-bucket');
        var newFile = new File(newBucket, 'new-file');
        var expectedPath =
          util.format('/o/{srcName}/copyTo/b/{destBucket}/o/{destName}', {
            srcName: file.name,
            destBucket: newBucket.name,
            destName: newFile.name
          });
        assertPathEquals(file, expectedPath, done);
        file.copy(newFile);
      });
    });

    describe('returned File object', function() {
      beforeEach(function() {
        file.makeReq_ = function(method, path, qs, body, callback) {
          callback();
        };
      });

      it('should re-use file object if one is provided', function(done) {
        var newBucket = new Bucket({}, 'new-bucket');
        var newFile = new File(newBucket, 'new-file');
        file.copy(newFile, function(err, copiedFile) {
          assert.ifError(err);
          assert.deepEqual(copiedFile, newFile);
          done();
        });
      });

      it('should create new file on the same bucket', function(done) {
        var newFilename = 'new-filename';
        file.copy(newFilename, function(err, copiedFile) {
          assert.ifError(err);
          assert.equal(copiedFile.bucket.name, bucket.name);
          assert.equal(copiedFile.name, newFilename);
          done();
        });
      });

      it('should create new file on the destination bucket', function(done) {
        var newBucket = new Bucket({}, 'new-bucket');
        file.copy(newBucket, function(err, copiedFile) {
          assert.ifError(err);
          assert.equal(copiedFile.bucket.name, newBucket.name);
          assert.equal(copiedFile.name, file.name);
          done();
        });
      });
    });
  });

  describe('createReadStream', function() {
    var metadata = { mediaLink: 'filelink' };

    it('should confirm file exists before reading', function(done) {
      file.getMetadata = function() {
        done();
      };
      file.createReadStream();
    });

    it('should emit error if stat returns error', function(done) {
      var error = new Error('Error.');
      file.getMetadata = function(callback) {
        setImmediate(function() {
          callback(error);
        });
      };
      file.createReadStream()
        .once('error', function(err) {
          assert.equal(err, error);
          done();
        });
    });

    it('should create an authorized request', function(done) {
      request_Override = function(opts) {
        assert.equal(opts.uri, metadata.mediaLink);
        done();
      };
      file.getMetadata = function(callback) {
        callback(null, metadata);
      };
      file.createReadStream();
    });

    it('should emit an error from authorizing', function(done) {
      var error = new Error('Error.');
      file.bucket.storage.makeAuthorizedRequest_ = function(opts, callback) {
        (callback.onAuthorized || callback)(error);
      };
      file.getMetadata = function(callback) {
        setImmediate(function() {
          callback(null, metadata);
        });
      };
      file.createReadStream()
        .once('error', function(err) {
          assert.equal(err, error);
          done();
        });
    });

    it('should get readable stream from request', function(done) {
      var fakeRequest = { a: 'b', c: 'd' };
      file.getMetadata = function(callback) {
        callback(null, metadata);
      };
      request_Override = function(req) {
        assert.deepEqual(req, fakeRequest);
        done();
      };
      file.bucket.storage.makeAuthorizedRequest_ = function(opts, callback) {
        (callback.onAuthorized || callback)(null, fakeRequest);
      };
      file.createReadStream();
    });

    it('should set readable stream', function() {
      var dup = duplexify();
      file.getMetadata = function(callback) {
        callback(null, metadata);
      };
      request_Override = function() {
        return dup;
      };
      file.bucket.storage.makeAuthorizedRequest_ = function(opts, callback) {
        (callback.onAuthorized || callback)();
      };
      file.createReadStream();
      assert.deepEqual(readableStream, dup);
      readableStream = null;
    });
  });

  describe('createWriteStream', function() {
    var METADATA = { a: 'b', c: 'd' };

    it('should return a stream', function() {
      assert(file.createWriteStream() instanceof stream);
    });

    it('should emit errors', function(done) {
      var error = new Error('Error.');

      file.bucket.storage.makeAuthorizedRequest_ = function(reqOpts, cb) {
        cb(error);
      };

      var writable = file.createWriteStream();

      writable.on('error', function(err) {
        assert.equal(err, error);
        done();
      });

      writable.write('data');
    });

    it('should start a simple upload if specified', function(done) {
      var writable = file.createWriteStream({
        metadata: METADATA,
        resumable: false
      });

      file.startSimpleUpload_ = function(stream, metadata) {
        assert.deepEqual(metadata, METADATA);
        done();
      };

      writable.write('data');
    });

    it('should start a resumable upload if specified', function(done) {
      var writable = file.createWriteStream({
        metadata: METADATA,
        resumable: true
      });

      file.startResumableUpload_ = function(stream, metadata) {
        assert.deepEqual(metadata, METADATA);
        done();
      };

      writable.write('data');
    });

    it('should default to a resumable upload', function(done) {
      var writable = file.createWriteStream({
        metadata: METADATA
      });

      file.startResumableUpload_ = function(stream, metadata) {
        assert.deepEqual(metadata, METADATA);
        done();
      };

      writable.write('data');
    });

    describe('validation', function() {
      var data = 'test';

      var crc32cBase64 = new Buffer([crc.calculate(data)]).toString('base64');

      var md5HashBase64 = crypto.createHash('md5');
      md5HashBase64.update(data);
      md5HashBase64 = md5HashBase64.digest('base64');

      var fakeMetadata = {
        crc32c: { crc32c: '####' + crc32cBase64 },
        md5: { md5Hash: md5HashBase64 }
      };

      it('should validate with crc32c', function(done) {
        var writable = file.createWriteStream({ validation: 'crc32c' });

        file.startResumableUpload_ = function(stream) {
          setImmediate(function() {
            stream.emit('complete', fakeMetadata.crc32c);
          });
        };

        writable.write(data);
        writable.end();

        writable
          .on('error', done)
          .on('complete', function() {
            done();
          });
      });

      it('should emit an error if crc32c validation fails', function(done) {
        var writable = file.createWriteStream({ validation: 'crc32c' });

        file.startResumableUpload_ = function(stream) {
          setImmediate(function() {
            stream.emit('complete', fakeMetadata.crc32c);
          });
        };

        file.delete = function(cb) {
          cb();
        };

        writable.write('bad-data');
        writable.end();

        writable.on('error', function(err) {
          assert.equal(err.code, 'FILE_NO_UPLOAD');
          done();
        });
      });

      it('should validate with md5', function(done) {
        var writable = file.createWriteStream({ validation: 'md5' });

        file.startResumableUpload_ = function(stream) {
          setImmediate(function() {
            stream.emit('complete', fakeMetadata.md5);
          });
        };

        writable.write(data);
        writable.end();

        writable
          .on('error', done)
          .on('complete', function() {
            done();
          });
      });

      it('should emit an error if md5 validation fails', function(done) {
        var writable = file.createWriteStream({ validation: 'md5' });

        file.startResumableUpload_ = function(stream) {
          setImmediate(function() {
            stream.emit('complete', fakeMetadata.md5);
          });
        };

        file.delete = function(cb) {
          cb();
        };

        writable.write('bad-data');
        writable.end();

        writable.on('error', function(err) {
          assert.equal(err.code, 'FILE_NO_UPLOAD');
          done();
        });
      });

      it('should default to md5 validation', function(done) {
        var writable = file.createWriteStream();

        file.startResumableUpload_ = function(stream) {
          setImmediate(function() {
            stream.emit('complete', { md5Hash: 'bad-hash' });
          });
        };

        file.delete = function(cb) {
          cb();
        };

        writable.write(data);
        writable.end();

        writable.on('error', function(err) {
          assert.equal(err.code, 'FILE_NO_UPLOAD');
          done();
        });
      });

      it('should delete the file if validation fails', function(done) {
        var writable = file.createWriteStream();

        file.startResumableUpload_ = function(stream) {
          setImmediate(function() {
            stream.emit('complete', { md5Hash: 'bad-hash' });
          });
        };

        file.delete = function() {
          done();
        };

        writable.write(data);
        writable.end();
      });

      it('should emit a different error if delete fails', function(done) {
        var writable = file.createWriteStream();

        file.startResumableUpload_ = function(stream) {
          setImmediate(function() {
            stream.emit('complete', { md5Hash: 'bad-hash' });
          });
        };

        var deleteErrorMessage = 'Delete error message.';
        var deleteError = new Error(deleteErrorMessage);
        file.delete = function(cb) {
          cb(deleteError);
        };

        writable.write(data);
        writable.end();

        writable.on('error', function(err) {
          assert.equal(err.code, 'FILE_NO_UPLOAD_DELETE');
          assert(err.message.indexOf(deleteErrorMessage > -1));
          done();
        });
      });
    });
  });

  describe('delete', function() {
    it('should delete the file', function(done) {
      file.makeReq_ = function(method, path, query, body) {
        assert.equal(method, 'DELETE');
        assert.equal(path, '/o/' + FILE_NAME);
        assert.strictEqual(query, null);
        assert.strictEqual(body, true);
        done();
      };
      file.delete();
    });

    it('should URI encode file names', function(done) {
      directoryFile.makeReq_ = function(method, path) {
        assert.equal(path, '/o/' + encodeURIComponent(directoryFile.name));
        done();
      };

      directoryFile.delete();
    });

    it('should execute callback', function(done) {
      file.makeReq_ = function(method, path, query, body, callback) {
        callback();
      };
      file.delete(done);
    });
  });

  describe('getMetadata', function() {
    var metadata = { a: 'b', c: 'd' };

    it('should get the metadata of a file', function(done) {
      file.makeReq_ = function(method, path, query, body) {
        assert.equal(method, 'GET');
        assert.equal(path, '/o/' + FILE_NAME);
        assert.strictEqual(query, null);
        assert.strictEqual(body, true);
        done();
      };
      file.getMetadata();
    });

    it('should URI encode file names', function(done) {
      directoryFile.makeReq_ = function(method, path) {
        assert.equal(path, '/o/' + encodeURIComponent(directoryFile.name));
        done();
      };

      directoryFile.getMetadata();
    });

    it('should execute callback', function(done) {
      file.makeReq_ = function(method, path, query, body, callback) {
        callback();
      };
      file.getMetadata(done);
    });

    it('should update metadata property on object', function() {
      file.makeReq_ = function(method, path, query, body, callback) {
        callback(null, metadata);
      };
      assert.deepEqual(file.metadata, {});
      file.getMetadata(function(err, newMetadata) {
        assert.deepEqual(newMetadata, metadata);
      });
      assert.deepEqual(file.metadata, metadata);
    });

    it('should pass metadata to callback', function(done) {
      file.makeReq_ = function(method, path, query, body, callback) {
        callback(null, metadata);
      };
      file.getMetadata(function(err, fileMetadata) {
        assert.deepEqual(fileMetadata, metadata);
        done();
      });
    });
  });

  describe('getSignedUrl', function() {
    var credentials = require('../testdata/privateKeyFile.json');

    beforeEach(function() {
      var storage = bucket.storage;
      storage.makeAuthorizedRequest_.getCredentials = function(callback) {
        callback(null, credentials);
      };
    });

    it('should create a signed url', function(done) {
      file.getSignedUrl({
        action: 'read',
        expires: Math.round(Date.now() / 1000) + 5
      }, function(err, signedUrl) {
        assert.ifError(err);
        assert.equal(typeof signedUrl, 'string');
        done();
      });
    });

    it('should URI encode file names', function(done) {
      directoryFile.getSignedUrl({
        action: 'read',
        expires: Math.round(Date.now() / 1000) + 5
      }, function(err, signedUrl) {
        assert(signedUrl.indexOf(encodeURIComponent(directoryFile.name)) > -1);
        done();
      });
    });

    describe('expires', function() {
      var nowInSeconds = Math.floor(Date.now() / 1000);

      it('should use the provided expiration date', function(done) {
        var expirationTimestamp = nowInSeconds + 60;
        file.getSignedUrl({
          action: 'read',
          expires: expirationTimestamp
        }, function(err, signedUrl) {
          assert.ifError(err);
          var expires = url.parse(signedUrl, true).query.Expires;
          assert.equal(expires, expirationTimestamp);
          done();
        });
      });

      it('should throw if a date from the past is given', function() {
        var expirationTimestamp = nowInSeconds - 1;
        assert.throws(function() {
          file.getSignedUrl({
            action: 'read',
            expires: expirationTimestamp
          }, function() {});
        }, /cannot be in the past/);
      });
    });
  });

  describe('setMetadata', function() {
    var metadata = { fake: 'metadata' };

    it('should set metadata', function(done) {
      file.makeReq_ = function(method, path, query, body) {
        assert.equal(method, 'PATCH');
        assert.equal(path, '/o/' + file.name);
        assert.deepEqual(body, metadata);
        done();
      };
      file.setMetadata(metadata);
    });

    it('should URI encode file names', function(done) {
      directoryFile.makeReq_ = function(method, path) {
        assert.equal(path, '/o/' + encodeURIComponent(directoryFile.name));
        done();
      };

      directoryFile.setMetadata();
    });

    it('should execute callback', function(done) {
      file.makeReq_ = function(method, path, query, body, callback) {
        callback();
      };
      file.setMetadata(metadata, done);
    });

    it('should update internal metadata property', function() {
      file.makeReq_ = function(method, path, query, body, callback) {
        callback(null, metadata);
      };
      file.setMetadata(metadata, function() {
        assert.deepEqual(file.metadata, metadata);
      });
    });
  });

  describe('startResumableUpload_', function() {
    var RESUMABLE_URI = 'http://resume';

    beforeEach(function() {
      configStoreData = {};
    });

    describe('starting', function() {
      it('should start a resumable upload', function(done) {
        file.bucket.storage.makeAuthorizedRequest_ = function(reqOpts) {
          var uri = 'https://www.googleapis.com/upload/storage/v1/b/' +
            file.bucket.name + '/o';

          assert.equal(reqOpts.method, 'POST');
          assert.equal(reqOpts.uri, uri);
          assert.equal(reqOpts.qs.name, file.name);
          assert.equal(reqOpts.qs.uploadType, 'resumable');

          assert.deepEqual(reqOpts.headers, {
            'X-Upload-Content-Type': 'custom'
          });
          assert.deepEqual(reqOpts.json, { contentType: 'custom' });

          done();
        };

        file.startResumableUpload_(duplexify(), { contentType: 'custom' });
      });

      it('should upload file', function(done) {
        var requestCount = 0;
        file.bucket.storage.makeAuthorizedRequest_ = function(reqOpts, cb) {
          requestCount++;

          // respond to creation POST.
          if (requestCount === 1) {
            cb(null, null, { headers: { location: RESUMABLE_URI }});
            assert.deepEqual(configStoreData[file.name].uri, RESUMABLE_URI);
            return;
          }

          // create an authorized request for the first PUT.
          if (requestCount === 2) {
            assert.equal(reqOpts.method, 'PUT');
            assert.equal(reqOpts.uri, RESUMABLE_URI);
            cb.onAuthorized(null, { headers: {} });
          }
        };

        // respond to first upload PUT request.
        var metadata = { a: 'b', c: 'd' };
        request_Override = function(reqOpts) {
          assert.equal(reqOpts.headers['Content-Range'], 'bytes 0-*/*');

          var stream = through();
          setImmediate(function() {
            stream.emit('complete', { body: metadata });
          });
          return stream;
        };

        var stream = duplexify();

        stream
          .on('error', done)
          .on('complete', function(data) {
            assert.deepEqual(data, metadata);

            setImmediate(function() {
              // cache deleted.
              assert(!configStoreData[file.name]);
              done();
            });
          });

        file.startResumableUpload_(stream);
      });
    });

    describe('resuming', function() {
      beforeEach(function() {
        configStoreData[file.name] = {
          uri: RESUMABLE_URI
        };
      });

      it('should resume uploading from last sent byte', function(done) {
        var lastByte = 135;

        var requestCount = 0;
        file.bucket.storage.makeAuthorizedRequest_ = function(reqOpts, cb) {
          requestCount++;

          if (requestCount === 1) {
            assert.equal(reqOpts.method, 'PUT');
            assert.equal(reqOpts.uri, RESUMABLE_URI);
            assert.deepEqual(reqOpts.headers, {
              'Content-Length': 0,
              'Content-Range': 'bytes */*'
            });

            cb({
              code: 308, // resumable upload status code
              response: { headers: { range: '0-' + lastByte } }
            });

            return;
          }

          if (requestCount === 2) {
            assert.equal(reqOpts.method, 'PUT');
            assert.equal(reqOpts.uri, RESUMABLE_URI);

            cb.onAuthorized(null, { headers: {} });
          }
        };

        var metadata = { a: 'b', c: 'd' };
        request_Override = function(reqOpts) {
          var startByte = lastByte + 1;
          assert.equal(
            reqOpts.headers['Content-Range'], 'bytes ' + startByte + '-*/*');

          var stream = through();
          setImmediate(function() {
            stream.emit('complete', { body: metadata });
          });
          return stream;
        };

        var stream = duplexify();

        stream
          .on('error', done)
          .on('complete', function(data) {
            assert.deepEqual(data, metadata);

            setImmediate(function() {
              // cache deleted.
              assert(!configStoreData[file.name]);
              done();
            });
          });

        file.startResumableUpload_(stream);
      });
    });
  });

  describe('startSimpleUpload_', function() {
    it('should get a writable stream', function(done) {
      makeWritableStream_Override = function() {
        done();
      };

      file.startSimpleUpload_(duplexify());
    });

    it('should pass the required arguments', function(done) {
      var metadata = { a: 'b', c: 'd' };

      makeWritableStream_Override = function(stream, options) {
        assert.deepEqual(options.metadata, metadata);
        assert.deepEqual(options.request, {
          qs: {
            name: file.name
          },
          uri: 'https://www.googleapis.com/upload/storage/v1/b/' +
            file.bucket.name + '/o'
        });
        done();
      };

      file.startSimpleUpload_(duplexify(), metadata);
    });

    it('should finish stream and set metadata', function(done) {
      var metadata = { a: 'b', c: 'd' };

      makeWritableStream_Override = function(stream, options, callback) {
        callback(metadata);
      };

      var stream = duplexify();

      stream
        .on('error', done)
        .on('complete', function(meta) {
          assert.deepEqual(meta, metadata);
          assert.deepEqual(file.metadata, metadata);
          done();
        });

      file.startSimpleUpload_(stream, metadata);
    });
  });
});