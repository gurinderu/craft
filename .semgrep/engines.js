export const meta = { name: 'semgrep-fixture' }
// ruleid: engine-clock
const t = Date.now()
// ruleid: engine-clock
const r = Math . random ()
// ruleid: engine-clock, engine-clock-global-as-value
const d = new Date()
// ruleid: engine-clock, engine-clock-global-as-value
const e = new Date
// ruleid: engine-clock
const now = Date.now
// ruleid: engine-clock, engine-clock-global-as-value
const r2 = Math['random']
// ruleid: engine-clock, engine-clock-global-as-value
const s = Date()
// ruleid: engine-clock
const re = /`/; const t4 = Date.now()
// ruleid: engine-clock-global-as-value
const { now: n2 } = Date
// ruleid: engine-clock, engine-clock-global-as-value
const D = Date; D.now()
// ruleid: engine-clock
;(Date).now()
// ruleid: engine-clock, engine-clock-global-as-value
new (Date)()
// ruleid: engine-clock
new Date(...[])
// ruleid: engine-clock, engine-clock-global-as-value
const k = 'now'; Date[k]()
// ruleid: engine-clock-global-as-value
const o = { Date }
// ruleid: engine-clock-global-as-value
f(Math)
// ruleid: engine-clock-global-as-value
Date?.now()
// ruleid: engine-clock, engine-clock-global-as-value
Date[`now`]()
// ruleid: engine-clock-global-as-value
Reflect.get(Date, 'now')()
// ruleid: engine-clock
;(0, Date.now)()
// ruleid: engine-clock
Date.now.call(null)
// ruleid: engine-clock, engine-clock-global-as-value
let D4; D4 = Date; D4.now()
// ruleid: engine-clock-global-as-value
function h(X) { return X.now() }; h(Date)
// ruleid: engine-no-globalthis
globalThis.Date.now()
// ruleid: engine-no-globalthis
globalThis['Math'].random()
// ruleid: engine-no-globalthis
globalThis.globalThis.Date.now()
// ruleid: engine-no-globalthis
const g = globalThis; g.Date.now()
// ruleid: engine-no-globalthis
const { Date: D3 } = globalThis; D3.now()
// ruleid: engine-host-route
const rq = require('x')
// ruleid: engine-host-route
async function im() { return await import('node:util') }
// ruleid: engine-host-route
const m = import.meta.url
// ruleid: engine-host-route
const ev = eval('1')
// ruleid: engine-host-route
const fn = new Function('return 1')()
// ruleid: engine-host-route
const F = Function
// Date.now() Math.random() require('x') eval() in a comment
/** Math.random() in JSDoc */
const ok1 = new Date(ts)
const ok2 = new Intl.DateTimeFormat()
const ok3 = new DateRange()
const ok4 = 'a // Date.now()' + `template Date.now() ${1}`
const ok5 = new Date(...parts, 1)
const ok6 = x instanceof Date
const ok7 = Date.parse(s) + Math.max(1, 2) + Date.UTC(2020, 1)
const ok8 = { Date: 1, Math: 2 }.Date
const ok9 = obj.Date.now()
const ok10 = new Date(x).getTime()
const ok11 = o.globalThis + o.Function + o.eval + o.require
const ok12 = { globalThis: 1, eval: 2, Function: 3, require: 4 }
const { globalThis: ok13, eval: ok14 } = o
return [t]
