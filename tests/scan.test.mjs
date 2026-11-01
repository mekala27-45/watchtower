import test from 'node:test';
import assert from 'node:assert/strict';
import {scanText} from '../scripts/scan.mjs';
test('secret scan accepts inert placeholder',()=>assert.deepEqual(scanText('DATABASE_URL=SET_IN_PLATFORM'),[]));
test('secret scan rejects constructed credential',()=>assert.ok(scanText('gh'+'p_'+'a'.repeat(36)).includes('github_token')));
test('secret scan empty text is not a repository pass',()=>assert.deepEqual(scanText(''),[]));
