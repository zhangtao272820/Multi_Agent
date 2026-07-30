/**
 * extractHttpUrl SSOT smoke（纯函数，无网络）
 */
import assert from 'node:assert/strict'
import {
  extractAllHttpUrls,
  extractFirstHttpUrl,
  sanitizeExtractedHttpUrl,
} from '../extractHttpUrl'

assert.equal(
  extractFirstHttpUrl('打开 https://www.runoob.com/，点击第一个教程'),
  'https://www.runoob.com/',
  'fullwidth comma + CJK must not pollute',
)
assert.equal(
  extractFirstHttpUrl('打开 https://www.runoob.com/ 。点击教程'),
  'https://www.runoob.com/',
  'fullwidth period after URL',
)
assert.equal(
  extractFirstHttpUrl('见 https://example.com/path?q=1&x=2 即可'),
  'https://example.com/path?q=1&x=2',
  'query string preserved',
)
assert.equal(
  extractFirstHttpUrl('链接：https://www.runoob.com/html/html-tutorial.html。'),
  'https://www.runoob.com/html/html-tutorial.html',
  'ascii trail punct stripped',
)
assert.equal(
  extractFirstHttpUrl(
    '打开 https://www.runoob.com/%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84/ 看',
  ),
  'https://www.runoob.com/%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84/',
  'percent-encoded path kept',
)
assert.equal(
  sanitizeExtractedHttpUrl('https://www.runoob.com/，点击第一个'),
  'https://www.runoob.com/',
  'sanitize polluted startUrl',
)
assert.deepEqual(
  extractAllHttpUrls('先 https://a.com/ ，再 https://b.com/x'),
  ['https://a.com/', 'https://b.com/x'],
  'extract all',
)
assert.equal(extractFirstHttpUrl('没有链接'), undefined, 'no url')
assert.equal(sanitizeExtractedHttpUrl('https://...'), undefined, 'reject LLM placeholder host ...')
assert.equal(sanitizeExtractedHttpUrl('https://.../path'), undefined, 'reject placeholder with path')
assert.equal(
  extractFirstHttpUrl('打开 https://... 点击教程'),
  undefined,
  'placeholder must not extract',
)

console.log('smoke-extract-http-url: PASS')
