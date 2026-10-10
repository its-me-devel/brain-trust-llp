'use strict';

// Minimal mock of the Google Apps Script runtime so apps-script/Code.gs can
// be loaded and exercised under plain Node, without a real deployment,
// a real Sheet, or sending a real email.
//
// Code.gs is written in GAS's "global functions/vars, no module system"
// style, so it's loaded with vm.runInContext() against a sandbox exposing
// just the globals it actually touches (SpreadsheetApp, MailApp,
// CacheService, LockService, ContentService, console) - the same contract
// a real Apps Script execution provides, minus everything else GAS offers
// that this file doesn't use.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE_GS_PATH = path.join(__dirname, '..', 'apps-script', 'Code.gs');

// Google Sheets' documented per-cell character limit. Used to make the
// appendRow() mock fail the same way a real oversized write would.
const SHEET_CELL_CHAR_LIMIT = 50000;

function makeMockSheet(name) {
  return {
    name,
    rows: [],
    appendRow(values) {
      for (const v of values) {
        if (typeof v === 'string' && v.length > SHEET_CELL_CHAR_LIMIT) {
          throw new Error(
            'This action would increase the number of characters in a cell past the limit of ' +
              SHEET_CELL_CHAR_LIMIT +
              ' characters.'
          );
        }
      }
      this.rows.push(values.slice());
    },
    getLastRow() {
      return this.rows.length;
    },
    setFrozenRows() {},
  };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.appendRowThrows] - force every appendRow() call to throw.
 * @param {boolean} [opts.mailThrows] - force every MailApp.sendEmail() call to throw.
 * @param {boolean} [opts.lockUnavailable] - force LockService.tryLock() to return false.
 * @param {(key: string) => boolean} [opts.cachePutThrowsFor] - force cache.put() to throw for matching keys.
 */
function loadCodeGs(opts = {}) {
  const source = fs.readFileSync(CODE_GS_PATH, 'utf8');

  const state = {
    sheetsByName: new Map(),
    sentEmails: [],
    cacheStore: new Map(),
    consoleErrors: [],
    lockHeldCount: 0,
  };

  const mockSpreadsheet = {
    getUrl() {
      return 'https://mock.example/spreadsheet/mock-id';
    },
    getSheetByName(name) {
      return state.sheetsByName.get(name) || null;
    },
    insertSheet(name) {
      const sheet = makeMockSheet(name);
      state.sheetsByName.set(name, sheet);
      return sheet;
    },
  };

  const SpreadsheetApp = {
    getActiveSpreadsheet() {
      return mockSpreadsheet;
    },
  };

  const MailApp = {
    sendEmail(options) {
      if (opts.mailThrows) {
        throw new Error('Service invoked too many times for one day: email.');
      }
      state.sentEmails.push(options);
    },
  };

  function makeCache() {
    return {
      get(key) {
        const entry = state.cacheStore.get(key);
        if (!entry) return null;
        // Real CacheService entries expire after their TTL. Modeling that
        // here (keyed off the same Date the sandbox uses, so tests can
        // fast-forward it) is what makes expiry-related behavior testable
        // instead of just asserted.
        if (Date.now() >= entry.expiresAt) {
          state.cacheStore.delete(key);
          return null;
        }
        return entry.value;
      },
      put(key, value, ttlSeconds) {
        if (opts.cachePutThrowsFor && opts.cachePutThrowsFor(key)) {
          throw new Error('Argument too large: key. Maximum size is 250 bytes.');
        }
        const ttlMs = (typeof ttlSeconds === 'number' ? ttlSeconds : 600) * 1000;
        state.cacheStore.set(key, { value: String(value), expiresAt: Date.now() + ttlMs });
      },
      remove(key) {
        state.cacheStore.delete(key);
      },
    };
  }

  const CacheService = {
    getScriptCache() {
      return makeCache();
    },
  };

  const LockService = {
    getScriptLock() {
      return {
        tryLock() {
          if (opts.lockUnavailable) {
            return false;
          }
          state.lockHeldCount += 1;
          return true;
        },
        releaseLock() {
          state.lockHeldCount = Math.max(0, state.lockHeldCount - 1);
        },
      };
    },
  };

  const ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput(text) {
      return {
        _text: text,
        setMimeType(mime) {
          this._mime = mime;
          return this;
        },
        getContent() {
          return this._text;
        },
      };
    },
  };

  const sandboxConsole = {
    error(...args) {
      state.consoleErrors.push(args.map(String).join(' '));
    },
    log() {},
  };

  if (opts.appendRowThrows) {
    const realInsertSheet = mockSpreadsheet.insertSheet.bind(mockSpreadsheet);
    mockSpreadsheet.insertSheet = function (name) {
      const sheet = realInsertSheet(name);
      sheet.appendRow = () => {
        throw new Error('Internal error: Service Spreadsheets failed.');
      };
      return sheet;
    };
  }

  const sandbox = {
    SpreadsheetApp,
    MailApp,
    CacheService,
    LockService,
    ContentService,
    console: sandboxConsole,
    // vm.createContext() gives the sandbox its own realm with its own
    // built-in intrinsics by default - e.g. a `new Date()` created inside
    // Code.gs would be an instance of *that* realm's Date, not this file's
    // Date, so `instanceof Date` in a test would wrongly fail. Sharing
    // this realm's built-ins keeps object identity consistent for tests.
    Date,
    Math,
    JSON,
    String,
    Number,
    Object,
    Array,
    RegExp,
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'Code.gs' });

  return { context, state };
}

function makeEvent(parameter) {
  return { parameter: parameter || {} };
}

function parseResponse(result) {
  return JSON.parse(result.getContent());
}

module.exports = { loadCodeGs, makeEvent, parseResponse };
