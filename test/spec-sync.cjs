// Verifies that 需求.txt embeds the real files verbatim.
// The spec exists so another agent can reproduce this plugin exactly, so any drift
// between a code block in the document and the shipped file is a defect.
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const spec = fs.readFileSync(path.join(root, '需求.txt'), 'utf8').replace(/\r\n/g, '\n')
const BT = String.fromCharCode(96)

let failures = 0
const assert = (label, ok, detail) => {
  if (!ok) failures++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '\n      ' + detail))
}

// A file block is: "文件 N：<name>" heading, a dashed separator, the content,
// then another dashed separator. Returns the content between the two separators.
function blockFor(fileLabel) {
  const headingAt = spec.search(new RegExp('^文件 ' + fileLabel + '：', 'm'))
  if (headingAt < 0) return undefined
  const afterHeading = spec.indexOf('\n', headingAt) + 1
  const sepEnd = spec.indexOf('\n', afterHeading) + 1
  if (!/^-{8,}\s*$/.test(spec.slice(afterHeading, sepEnd).trim())) return undefined
  const closeAt = spec.indexOf('\n----', sepEnd)
  if (closeAt < 0) return undefined
  return spec.slice(sepEnd, closeAt).replace(/\n+$/, '')
}

// The block content starts right after the separator line; a blank line there is layout,
// not content, so both sides are compared with leading blank lines stripped.
const trimBlanks = (text) => text.replace(/^\n+/, '').replace(/\n+$/, '')

const read = (rel) =>
  fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '')

function firstDiff(a, b) {
  const left = a.split('\n')
  const right = b.split('\n')
  let line = 0
  while (line < left.length && line < right.length && left[line] === right[line]) line++
  return `first difference at line ${line + 1}:\n      spec: ${JSON.stringify(left[line])}\n      file: ${JSON.stringify(right[line])}\n      (spec ${left.length} lines, file ${right.length} lines)`
}

const files = [
  ['1', 'package.json'],
  ['2', 'cordis.patch.yml'],
  ['3', 'lib/index.js'],
  ['4', 'locale/en.json'],
  ['5', 'locale/zh.json'],
  ['6', 'icon.svg'],
  ['7', 'client/client.js'],
]

for (const [label, rel] of files) {
  const embedded = blockFor(label)
  if (embedded === undefined) {
    assert(`${rel}: block present in spec`, false, 'could not locate the block')
    continue
  }
  const real = read(rel)
  if (embedded === real) {
    assert(`${rel}: spec block matches the file verbatim`, true)
  } else if (trimBlanks(embedded) === trimBlanks(real)) {
    assert(`${rel}: spec block matches the file verbatim`, true)
  } else {
    assert(`${rel}: spec block matches the file verbatim`, false, firstDiff(trimBlanks(embedded), trimBlanks(real)))
  }
}

// Section six repeats the stylesheet; it must equal STYLE_TEXT inside client.js.
const styleAt = spec.indexOf('html {\n  --dsh-settings-w: 800px;')
const styleEnd = spec.indexOf('\n\n----------- 三条实现要点', styleAt)
assert('section six publishes the stylesheet', styleAt > 0 && styleEnd > styleAt)
if (styleAt > 0 && styleEnd > styleAt) {
  const documented = spec.slice(styleAt, styleEnd).replace(/\n+$/, '')
  const source = read('client/client.js')
  const marker = 'const STYLE_TEXT = ' + BT
  const at = source.indexOf(marker)
  assert('STYLE_TEXT is a template literal in the code', at > 0)
  if (at > 0) {
    const bodyStart = at + marker.length
    const bodyEnd = source.indexOf(BT, bodyStart)
    const actual = trimBlanks(source.slice(bodyStart, bodyEnd))
    if (trimBlanks(documented) === actual) {
      assert('section six stylesheet matches STYLE_TEXT', true)
    } else {
      assert('section six stylesheet matches STYLE_TEXT', false, firstDiff(trimBlanks(documented), actual))
    }
  }
}

// Behavioural claims the document makes about the code.
const client = read('client/client.js')
const claims = [
  ['slider ranges', /WIDTH = \{ min: 640, max: 2400, step: 10, unit: 'px' \}/.test(client) && /HEIGHT = \{ min: 480, max: 2160, step: 10, unit: 'px' \}/.test(client) && /TRANSPARENCY = \{ min: 0, max: 100, step: 1, unit: '%' \}/.test(client)],
  ['defaults', /DEFAULT_STATE = \{ width: 800, height: 800, heightUnit: 'px', transparency: 0 \}/.test(client)],
  ['storage key', /STORAGE_KEY = 'dsh\.settingsResize\.v1'/.test(client)],
  ['slot id', /id: 'settings-resize'/.test(client)],
  ['slot order', /order: 18/.test(client)],
  ['slot target', /name: 'settings\.general\.item'/.test(client)],
  ['style element id', /STYLE_ID = 'dsh-settings-resize-style'/.test(client)],
  ['four custom properties', ['--dsh-settings-w', '--dsh-settings-h', '--dsh-settings-alpha', '--dsh-settings-edge'].every((v) => client.includes(v))],
  ['opacity is never used for the panel', !/\[data-shortcut-modal="settings"\][^}]*opacity:/s.test(client)],
  ['the outline, not a border, carries the edge', /outline: \.5px solid/.test(client)],
]
for (const [name, ok] of claims) assert(`code claim: ${name}`, ok)

// The document must keep the numbers it promises, since another agent copies them.
const specClaims = [
  ['documents width range 640–2400', spec.includes('640') && spec.includes('2400')],
  ['documents height range 480–2160', spec.includes('480') && spec.includes('2160')],
  ['documents transparency range 0–100', /透明度[\s\S]{0,80}max[\s\S]{0,20}100/.test(spec) || /透明度\s+transparency\s+0\s+100\s+1\s+%/.test(spec)],
  ['documents order 18', spec.includes('order=18')],
  ['records the vh decision', spec.includes('heightUnit:"vh"') || spec.includes('heightUnit: "vh"')],
  ['records the 42-test count', spec.includes('42')],
  ['records the unverified browser limit', spec.includes('未验证')],
]
for (const [name, ok] of specClaims) assert(`spec claim: ${name}`, ok)

console.log(failures === 0 ? '\nALL SPEC CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
if (failures !== 0) process.exitCode = 1
