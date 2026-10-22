// Checks that README.en.md describes the plugin accurately, since the awesome-list
// maintainers verify every claim in a submission against the code.
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const en = fs.readFileSync(path.join(root, 'README.en.md'), 'utf8')
const zh = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
const client = fs.readFileSync(path.join(root, 'client', 'client.js'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const results = []
const check = (label, ok, detail) => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '  [' + detail + ']'))
}

// --- claims about the sliders ------------------------------------------------------
check('claims three sliders and the code has three', /three sliders/i.test(en) && (client.match(/h\(Slider, \{/g) || []).length === 3)
check('states width range 640-2400', en.includes('640') && en.includes('2400') && /WIDTH = \{ min: 640, max: 2400/.test(client))
check('states height range 480-2160', en.includes('480') && en.includes('2160') && /HEIGHT = \{ min: 480, max: 2160/.test(client))
check('states transparency range 0-100', /transparency 0–100%/.test(en) && /TRANSPARENCY = \{ min: 0, max: 100/.test(client))
check('names the General settings section', /Settings → General/.test(en) && /settings\.general\.item/.test(client))
check('states defaults 800x800', en.includes('800 × 800') && /DEFAULT_STATE = \{ width: 800, height: 800/.test(client))

// --- storage ----------------------------------------------------------------------
check('names the storage key correctly', en.includes('dsh.settingsResize.v1') && /STORAGE_KEY = 'dsh\.settingsResize\.v1'/.test(client))
check('shows a record matching the real shape', en.includes('"width":1200,"height":900,"heightUnit":"px","transparency":20'))

// --- selectors and scoping --------------------------------------------------------
check('names the stable selector', en.includes('data-shortcut-modal="settings"') && client.includes('[data-shortcut-modal="settings"]'))
check('does not document the hashed class as a selector', !/wCInkW_panel\s*\{/.test(en))
check('explains why !important is needed', /!important` is required/.test(en))

// --- the surface-only transparency rationale --------------------------------------
check('explains outline over border', /`outline`, not a `border`/.test(en) && /outline-offset/.test(client))
check('documents both custom properties of the surface', en.includes('--dsh-settings-alpha') && en.includes('--dsh-settings-edge'))

// --- locale contract --------------------------------------------------------------
check('documents the hard locale dependency', /\['slots', 'locale'\]/.test(en) && /inject: \['slots', 'locale'\]/.test(client))
// `ctx.get('locale')` may appear only as the explanation of the bug, never as advice.
check(
  'mentions ctx.get only as the historical mistake, not as guidance',
  (() => {
    const section = en.split('### Locale wiring')[1] || ''
    const mentions = section.split("ctx.get('locale')").length - 1
    if (mentions === 0) return true
    // Any mention must sit in the same sentence as the failure it caused.
    return /Probing with `ctx\.get\('locale'\)`/.test(section) && /never display Chinese/.test(section)
  })(),
)

// --- file table and tests ---------------------------------------------------------
for (const f of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'client/client.js', 'icon.svg']) {
  check(`layout table lists ${f}`, en.includes('`' + f + '`'))
}
check('package files[] includes README.en.md', (pkg.files || []).includes('README.en.md'))

const declared = ['lifecycle.cjs', 'i18n.cjs', 'repro-hmr.cjs', 'repro-coldstart.cjs', 'spec-sync.cjs']
for (const t of declared) {
  check(`test table lists ${t}`, en.includes(t) && fs.existsSync(path.join(root, 'test', t)))
}
check('test counts match reality', en.includes('48 checks') && en.includes('15 checks') && en.includes('11 checks') && en.includes('9 checks') && en.includes('27 checks'))

// --- bilingual cross-links --------------------------------------------------------
check('English README links to the Chinese one', en.includes('[中文](README.md)'))
check('Chinese README links to the English one', zh.includes('[English](README.en.md)'))

// --- no stale claims from earlier versions ----------------------------------------
check('no longer says "two sliders"', !/two sliders/i.test(en) && !/两个滑动条/.test(zh))
check('no longer claims only three custom properties', !/three custom properties/i.test(en))

const failed = results.filter((ok) => !ok).length
console.log(failed === 0 ? '\nALL README CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
if (failed) process.exitCode = 1
