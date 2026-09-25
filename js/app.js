import { buildPayload } from './payload.js'

const TITLES = {
  home: 'หน้าแรก',
  shirts: 'จองเสื้อ',
  tables: 'จองโต๊ะ',
  lookup: 'ตรวจสอบการจอง',
  admin: 'ผู้จัดงาน',
}

const state = {
  catalog: null,
  loadError: '',
  page: readPage(),
  error: '',
  busy: false,
  shirt: blankShirt(),
  table: blankTable(),
  lookup: { phone: '', shirts: null, tables: null },
  admin: {
    token: sessionStorage.getItem('niti-admin') || '',
    password: '',
    bookings: null,
    filter: 'pending',
  },
  receiptView: null,
}

const SHIRT_MAX = 20

function blankShirt() {
  return {
    step: 1,
    items: {},
    name: '',
    phone: '',
    address: '',
    slipData: '',
    slipName: '',
    payOpen: false,
    success: null,
  }
}

function blankTable() {
  return {
    count: 1,
    hostName: '',
    phone: '',
    address: '',
    generation: '',
    slipData: '',
    slipName: '',
    payOpen: false,
    success: null,
  }
}

function readPage() {
  const hash = location.hash.replace(/^#\/?/, '')
  return TITLES[hash] ? hash : 'home'
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]))
}

function baht(amount) {
  return Number(amount).toLocaleString('th-TH') + ' บาท'
}

function digits(value) {
  return String(value ?? '').replace(/\D/g, '')
}

function phoneDigits(value) {
  let valueDigits = digits(value)
  if (valueDigits.startsWith('66') && valueDigits.length >= 11) {
    valueDigits = `0${valueDigits.slice(2)}`
  }
  return valueDigits
}

function validPhone(value) {
  return /^0\d{8,9}$/.test(phoneDigits(value))
}

function daysUntil(iso) {
  const [year, month, day] = iso.split('-').map(Number)
  const target = Date.UTC(year, month - 1, day)
  const [todayYear, todayMonth, todayDay] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()).split('-').map(Number)
  const today = Date.UTC(todayYear, todayMonth - 1, todayDay)
  return Math.round((target - today) / 86400000)
}

function when(iso) {
  return new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })
}

function statusText(status) {
  return { pending: 'รอตรวจสอบ', confirmed: 'ยืนยันแล้ว', cancelled: 'ยกเลิก' }[status] || status
}

async function api(path, options = {}) {
  let response
  try {
    response = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    })
  } catch {
    throw new Error('เชื่อมต่อระบบจองไม่สำเร็จ')
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด')
  return data
}

function shirtLines() {
  return Object.entries(state.shirt.items).filter(([, qty]) => qty > 0)
}

function shirtTotal() {
  return shirtLines().reduce((sum, [, qty]) => sum + qty * state.catalog.shirt.price, 0)
}

function tableTotal() {
  return state.table.count * state.catalog.table.price
}

function payloadFor(amount, reference) {
  const payment = state.catalog.payment
  return buildPayload({
    bankCode: payment.bankCode,
    accountNumber: payment.accountNumber,
    promptPay: payment.promptPay,
    amount: amount || null,
    reference,
  })
}

function render(keepFocus) {
  const root = document.getElementById('app')
  const active = document.activeElement
  const focusId = keepFocus && active ? active.id : ''
  const pos = keepFocus && active && 'selectionStart' in active ? active.selectionStart : null
  document.title = `${TITLES[state.page]} · นิติพะเยา คืนสู่เหย้า`
  if (!state.catalog) {
    root.innerHTML = state.loadError
      ? `<div class="loading"><p>${esc(state.loadError)}</p><button class="btn btn-dark" type="button" data-action="reload">ลองอีกครั้ง</button></div>`
      : `<div class="loading">กำลังโหลดข้อมูลงาน</div>`
    return
  }
  root.innerHTML = `${nav()}${pageBody()}${footer()}`
  document.body.classList.toggle('modal-open', (state.page === 'shirts' && state.shirt.payOpen) || (state.page === 'tables' && state.table.payOpen))
  mountQrs()
  if (focusId) {
    const field = document.getElementById(focusId)
    if (field) {
      field.focus()
      if (typeof pos === 'number' && field.setSelectionRange) {
        try { field.setSelectionRange(pos, pos) } catch { /* date inputs ignore this */ }
      }
    }
  }
}

function nav() {
  const link = (id, label) => {
    const href = id === 'home' ? '#/' : `#/${id}`
    const current = state.page === id ? ' aria-current="page"' : ''
    return `<a href="${href}"${current}>${label}</a>`
  }
  return `
    <header class="nav">
      <a class="brand" href="#/">
        <img class="brand-logo" src="/logo.jpg" width="180" height="101" alt="ชมรมศิษย์เก่านิติศาสตร์ มหาวิทยาลัยพะเยา">
        <span><strong>นิติพะเยา คืนสู่เหย้า</strong><small>หุบเขาฝนโปรยไพร</small></span>
      </a>
      <nav class="nav-links">
        ${link('home', 'หน้าแรก')}
        ${link('shirts', 'จองเสื้อ')}
        ${link('tables', 'จองโต๊ะ')}
        ${link('lookup', 'ตรวจสอบการจอง')}
      </nav>
    </header>`
}

function footer() {
  const event = state.catalog.event
  return `
    <footer>
      <div class="wrap">
        <p>${esc(event.organizer)}</p>
        <p><a href="#/admin">สำหรับผู้จัดงาน</a></p>
      </div>
    </footer>`
}

function pageBody() {
  if (state.page === 'shirts') return shirtsPage()
  if (state.page === 'tables') return tablesPage()
  if (state.page === 'lookup') return lookupPage()
  if (state.page === 'admin') return adminPage()
  return homePage()
}

function homePage() {
  const { event, shirt, table } = state.catalog
  const untilEvent = daysUntil(event.dateISO)
  const rain = Array.from({ length: 16 }, (_, i) => {
    const left = (i * 6.2) % 100
    return `<span style="left:${left}%;animation-delay:${(-i * 0.4).toFixed(2)}s;animation-duration:${6 + (i % 5)}s"></span>`
  }).join('')
  return `
    <section class="hero-band">
      <div class="wrap hero">
        <div>
          <img class="hero-logo" src="/logo.jpg" width="320" height="180" alt="ชมรมศิษย์เก่านิติศาสตร์ มหาวิทยาลัยพะเยา">
          <p class="eyebrow">${esc(event.faculty)}</p>
          <h1><span>นิติพะเยา</span><span>คืนสู่เหย้า</span></h1>
          <p class="theme">${esc(event.theme)}</p>
          <p class="lede">${esc(event.lede)}</p>
          <div class="hero-actions">
            <a class="btn btn-gold" href="#/shirts">จองเสื้อ ${baht(shirt.price)}</a>
            <a class="btn btn-ghost" href="#/tables">จองโต๊ะจีน ${baht(table.price)}</a>
          </div>
        </div>
        ${scene(rain)}
      </div>
      <div class="wrap facts">
        <div class="fact"><span>วันนัดพบ</span><strong>${esc(event.dateLabel)}</strong>${untilEvent > 0 ? `<span>อีก ${untilEvent} วัน</span>` : ''}</div>
        <div class="fact"><span>สถานที่</span><strong>${esc(event.venue)}</strong></div>
        <div class="fact"><span>การเดินทาง</span><strong><a href="${esc(event.mapUrl)}" target="_blank" rel="noopener">เปิดแผนที่</a></strong></div>
      </div>
    </section>
    <main>
      <div class="wrap">
        <section class="section">
          <h2 class="section-title">ลำดับการจอง</h2>
          <ol class="steps">
            <li><strong>กรอก</strong>ชื่อ เบอร์โทร และที่อยู่</li>
            <li><strong>เลือก</strong>ไซส์เสื้อหรือจำนวนโต๊ะจีน</li>
            <li><strong>สแกน</strong>คิวอาร์กรุงไทย แล้วตรวจชื่อบัญชีก่อนโอน</li>
            <li><strong>แนบสลิป</strong>ยืนยันการชำระ แล้วเก็บใบยืนยันการจอง</li>
          </ol>
        </section>
      </div>
    </main>`
}

function scene(rain) {
  return `
    <div class="scene-wrap" aria-hidden="true">
      <div class="rain">${rain}</div>
      <svg class="scene" viewBox="0 0 640 480">
        <path fill="#2c5a49" d="M0 210 120 150 190 188 280 96 360 170 470 88 560 150 640 120 640 480H0Z"/>
        <path fill="#1c4034" d="M0 268 150 188 230 236 320 160 410 230 520 176 640 214 640 480H0Z"/>
        <path fill="#143228" d="M0 330 180 250 270 300 390 240 500 310 640 260 640 480H0Z"/>
        <ellipse cx="300" cy="392" rx="230" ry="22" fill="#0c241c" opacity=".4"/>
        <g transform="translate(430 268)">
          <path fill="#e0c27a" d="M8 42 48 18 88 42H76v34H20V42Z"/>
          <path fill="#1b4034" d="M28 76h40V50H28Z"/>
        </g>
      </svg>
    </div>`
}

function paymentCard(amount, reference) {
  const payment = state.catalog.payment
  const payload = payloadFor(amount, reference)
  const heading = amount ? baht(amount) : 'สแกนแล้วใส่ยอดเอง'
  return `
    <section class="pay-card">
      <div class="qr-frame" data-qr="${esc(payload)}"></div>
      <div>
        <p class="kicker">ธนาคารกรุงไทย</p>
        <h3>${heading}</h3>
        <dl>
          <div><dt>ธนาคาร</dt><dd>${esc(payment.bank)}</dd></div>
          <div><dt>เลขที่บัญชี</dt><dd class="account">${esc(payment.accountNumber)}</dd></div>
          <div><dt>ชื่อบัญชี</dt><dd>${esc(payment.accountName)}</dd></div>
          ${reference ? `<div><dt>รหัสอ้างอิงในคิวอาร์</dt><dd>${esc(reference)}</dd></div>` : ''}
        </dl>
        <div class="row-actions no-print">
          <button class="btn btn-line" type="button" data-action="copy" data-value="${esc(digits(payment.accountNumber))}">คัดลอกเลขบัญชี</button>
          <button class="btn btn-line" type="button" data-action="download-qr" data-payload="${esc(payload)}" data-name="${esc(reference || 'krungthai')}">บันทึกคิวอาร์</button>
        </div>
        <p class="fine">เมื่อสแกนแล้ว ให้ตรวจชื่อผู้รับเป็น «${esc(payment.accountName)}» ก่อนกดยืนยันทุกครั้ง หากแอปอ่านคิวอาร์ไม่ได้ ให้โอนเข้าเลขบัญชีด้านบน</p>
      </div>
    </section>`
}

function deadlineBanner(open, label, noun) {
  if (!open) return `<p class="alert">ปิดรับจอง${noun}แล้วเมื่อ ${esc(label)}</p>`
  const key = noun === 'เสื้อ' ? state.catalog.shirt.deadline : state.catalog.table.deadline
  const days = daysUntil(key)
  if (days <= 0) return `<p class="alert soon">วันนี้เป็นวันสุดท้ายของการจอง${noun}</p>`
  if (days <= 7) return `<p class="alert soon">ใกล้ปิดรับจอง${noun} ภายในวันที่ ${esc(label)} เหลืออีก ${days} วัน</p>`
  return `<p class="alert ok">เปิดให้จองถึงวันที่ ${esc(label)}</p>`
}

function field(label, control, hint) {
  return `<label class="field"><span>${label}</span>${control}${hint ? `<small>${hint}</small>` : ''}</label>`
}

function shirtsPage() {
  const shirt = state.catalog.shirt
  if (state.shirt.success) return bookingReceipt('shirt', state.shirt.success)
  const step = state.shirt.step
  return `
    <main><div class="wrap shirt-flow">
      <div class="page-head">
        <p class="kicker">พรีออเดอร์</p>
        <h2>จองเสื้อที่ระลึก</h2>
        <p>ตัวละ ${baht(shirt.price)} สั่งได้ถึงวันที่ ${esc(shirt.deadlineLabel)}</p>
      </div>
      ${state.error && !state.shirt.payOpen ? `<p class="alert">${esc(state.error)}</p>` : ''}
      ${deadlineBanner(state.catalog.shirtOpen, shirt.deadlineLabel, 'เสื้อ')}
      <div class="shirt-photos">
        <figure>
          <img src="/shirt-sample.jpg" alt="เสื้อโปโลสีกรมท่า ด้านหน้าและด้านหลัง ราคา 350 บาท รหัส WA-212PLACL30">
          <figcaption>เสื้อโปโล WARRIX รหัส WA-212PLACL30 · ตัวละ ${baht(shirt.price)}</figcaption>
        </figure>
        <figure>
          <img src="/size-chart.jpg" alt="ตารางไซส์ XS ถึง 7L แสดงรอบอกและยาว">
          <figcaption>ตารางไซส์ รอบอกและยาว หน่วยเป็นนิ้ว</figcaption>
        </figure>
      </div>
      <ol class="wizard">
        <li class="${step === 1 ? 'on' : 'done'}">1. ชื่อ เบอร์โทร และที่อยู่</li>
        <li class="${step === 2 ? 'on' : ''}">2. เลือกไซส์และจำนวน</li>
      </ol>
      ${step === 1 ? shirtInfoStep() : shirtSizeStep()}
      ${state.shirt.payOpen ? shirtPayModal() : ''}
    </div></main>`
}

function shirtInfoStep() {
  const form = state.shirt
  return `
    <form class="panel" data-form="shirt-info">
      ${field('ชื่อ-นามสกุล', `<input id="shirt-name" data-bind="shirt.name" value="${esc(form.name)}" autocomplete="name" required>`)}
      ${field('เบอร์โทร', `<input id="shirt-phone" data-bind="shirt.phone" value="${esc(form.phone)}" inputmode="tel" autocomplete="tel" required>`)}
      ${field('ที่อยู่', `<textarea id="shirt-address" data-bind="shirt.address" required>${esc(form.address)}</textarea>`, 'ใช้สำหรับจัดส่งเสื้อ')}
      <button class="btn btn-dark" type="submit"${state.catalog.shirtOpen ? '' : ' disabled'}>ถัดไป เลือกไซส์</button>
    </form>`
}

function shirtSizeStep() {
  const shirt = state.catalog.shirt
  const form = state.shirt
  const lines = shirtLines()
  const pieces = lines.reduce((sum, [, qty]) => sum + qty, 0)
  return `
    <form class="panel" data-form="shirt-sizes">
      <p class="fine">${esc(form.name)} · ${esc(phoneDigits(form.phone))}<br>${esc(form.address)}</p>
      <p><button class="btn btn-line" type="button" data-action="shirt-back">แก้ไขข้อมูลผู้จอง</button></p>
      <div class="size-list">
        ${shirt.sizes.map((size) => {
          const qty = form.items[size] || 0
          return `<div class="size-row">
            <strong>${esc(size)}</strong>
            <span class="fine">${esc(shirt.sizeGuide[size] || '')}</span>
            <span class="stepper">
              <button type="button" data-action="qty" data-size="${esc(size)}" data-dir="-1" aria-label="ลดขนาด ${esc(size)}">−</button>
              <input id="qty-${esc(size)}" type="number" min="0" max="${SHIRT_MAX}" inputmode="numeric" value="${qty}" data-qty-size="${esc(size)}" aria-label="จำนวนขนาด ${esc(size)}">
              <button type="button" data-action="qty" data-size="${esc(size)}" data-dir="1" aria-label="เพิ่มขนาด ${esc(size)}">+</button>
            </span>
          </div>`
        }).join('')}
      </div>
      <div class="line"><span>รวม ${pieces} ตัว</span><strong>${baht(shirtTotal())}</strong></div>
      <button class="btn btn-dark" type="submit"${state.catalog.shirtOpen ? '' : ' disabled'}>ยืนยันรายการ</button>
    </form>`
}

function shirtPayModal() {
  const total = shirtTotal()
  const lines = shirtLines()
  return `
    <div class="modal-back">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="pay-title">
        <p class="kicker">ชำระเงิน</p>
        <h2 id="pay-title">สแกนคิวอาร์เพื่อโอนเงิน</h2>
        ${state.error ? `<p class="alert">${esc(state.error)}</p>` : ''}
        ${lines.map(([size, qty]) => `<div class="line"><span>ขนาด ${esc(size)} × ${qty}</span><span>${baht(qty * state.catalog.shirt.price)}</span></div>`).join('')}
        ${paymentCard(total, '')}
        <label class="btn btn-line slip-btn">
          ${state.shirt.slipData ? 'เปลี่ยนสลิป' : 'แนบสลิป'}
          <input type="file" accept="image/png,image/jpeg,image/webp" data-file="shirt">
        </label>
        ${state.shirt.slipData ? `<p class="fine">แนบแล้ว: ${esc(state.shirt.slipName)}</p><img class="slip-preview" alt="ตัวอย่างสลิป" src="${esc(state.shirt.slipData)}">` : '<p class="fine">แนบสลิปได้ก่อนกดยืนยันการโอน</p>'}
        <div class="row-actions">
          <button class="btn btn-dark" type="button" data-action="confirm-transfer"${state.busy ? ' disabled' : ''}>${state.busy ? 'กำลังบันทึก' : 'ยืนยันการโอน'}</button>
          <button class="btn btn-line" type="button" data-action="close-pay">กลับไปแก้รายการ</button>
        </div>
      </div>
    </div>`
}

function receiptModel(kind, order) {
  const event = state.catalog.event
  const slipNote = order.hasSlip
    ? 'แนบสลิปแล้ว รอผู้จัดงานตรวจสอบ'
    : 'ยังไม่ได้แนบสลิป สามารถแนบทีหลังได้ที่หน้าตรวจสอบการจอง'
  if (kind === 'shirt') {
    const pieces = order.items.reduce((sum, item) => sum + item.qty, 0)
    return {
      title: 'ใบยืนยันการจองเสื้อ',
      code: order.code,
      eventLine: `${event.faculty}`,
      themeLine: `${event.name} · ${event.theme}`,
      fields: [
        ['ชื่อ', order.name],
        ['เบอร์โทร', order.phone],
        ['ที่อยู่', order.address],
        ['วันที่จอง', when(order.createdAt)],
      ],
      lines: [
        ...order.items.map((item) => [`ขนาด ${item.size} × ${item.qty}`, baht(item.price * item.qty)]),
        [`รวม ${pieces} ตัว`, baht(order.total)],
      ],
      note: slipNote,
    }
  }
  return {
    title: 'ใบยืนยันการจองโต๊ะ',
    code: order.code,
    eventLine: event.faculty,
    themeLine: `${event.name} · ${event.theme}`,
      fields: [
        ['ชื่อ', order.hostName],
        ['รุ่น', order.generation],
        ['เบอร์โทร', order.phone],
        ['ที่อยู่', order.address],
        ['วันที่จอง', when(order.createdAt)],
      ],
    lines: [
      [`${order.tableCount} โต๊ะ · ${order.seats} ท่าน`, baht(order.total)],
    ],
    note: slipNote,
  }
}

function bookingReceipt(kind, order) {
  const model = receiptModel(kind, order)
  return `
    <main><div class="wrap">
      <article class="receipt">
        <header class="receipt-head">
          <p class="kicker">${esc(model.eventLine)}</p>
          <h2>${esc(model.title)}</h2>
          <p>${esc(model.themeLine)}</p>
          <p class="code">${esc(model.code)}</p>
        </header>
        <dl>
          ${model.fields.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}
        </dl>
        <div class="receipt-items">
          ${model.lines.map(([label, value], index) => `<div class="line"><span>${esc(label)}</span><${index === model.lines.length - 1 ? 'strong' : 'span'}>${esc(value)}</${index === model.lines.length - 1 ? 'strong' : 'span'}></div>`).join('')}
        </div>
        <p class="fine">${esc(model.note)}</p>
      </article>
      <div class="row-actions no-print">
        <button class="btn btn-dark" type="button" data-action="save-receipt" data-kind="${kind}">บันทึกรูปภาพ</button>
        <button class="btn btn-dark" type="button" data-action="save-receipt-pdf" data-kind="${kind}">บันทึก PDF</button>
        <button class="btn btn-line" type="button" data-action="print">พิมพ์ใบยืนยัน</button>
        <button class="btn btn-line" type="button" data-action="copy" data-value="${esc(order.code)}">คัดลอกรหัส</button>
        <button class="btn btn-line" type="button" data-action="again" data-kind="${kind}">จองรายการใหม่</button>
      </div>
    </div></main>`
}

function tablesPage() {
  const table = state.catalog.table
  const form = state.table
  if (form.success) return bookingReceipt('table', form.success)
  const total = tableTotal()
  return `
    <main><div class="wrap shirt-flow">
      <div class="page-head">
        <p class="kicker">งานเลี้ยงสังสรรค์</p>
        <h2>จองโต๊ะจีน</h2>
        <p>โต๊ะละ ${baht(table.price)} สำหรับ ${table.seats} ท่าน จองได้ถึงวันที่ ${esc(table.deadlineLabel)}</p>
      </div>
      ${state.error && !form.payOpen ? `<p class="alert">${esc(state.error)}</p>` : ''}
      ${deadlineBanner(state.catalog.tableOpen, table.deadlineLabel, 'โต๊ะ')}
      <form class="panel" data-form="table">
        ${field('ชื่อ-นามสกุล', `<input id="table-name" data-bind="table.hostName" value="${esc(form.hostName)}" autocomplete="name" required>`)}
        ${field('เบอร์โทร', `<input id="table-phone" data-bind="table.phone" value="${esc(form.phone)}" inputmode="tel" autocomplete="tel" required>`)}
        ${field('ที่อยู่', `<textarea id="table-address" data-bind="table.address" required>${esc(form.address)}</textarea>`, 'ใช้ติดต่อและยืนยันการจอง')}
        ${field('รุ่นปี / รหัสนิสิต *', `<input id="table-generation" data-bind="table.generation" value="${esc(form.generation)}" inputmode="numeric" required>`, 'ใส่ 2 หลักแรกของรหัสนิสิต เช่น 5103123 → 51 หรือ 5203123 → 52')}
        <label class="field"><span>จำนวนโต๊ะ</span>
          <span class="stepper">
            <button type="button" data-action="tables" data-dir="-1" aria-label="ลดจำนวนโต๊ะ">−</button>
            <strong>${form.count}</strong>
            <button type="button" data-action="tables" data-dir="1" aria-label="เพิ่มจำนวนโต๊ะ">+</button>
          </span>
          <small>${form.count} โต๊ะ · ${form.count * table.seats} ท่าน · ${baht(total)}</small>
        </label>
        <button class="btn btn-dark" type="submit"${state.catalog.tableOpen ? '' : ' disabled'}>ยืนยัน</button>
      </form>
      ${form.payOpen ? tablePayModal() : ''}
    </div></main>`
}

function tablePayModal() {
  const table = state.catalog.table
  const count = state.table.count
  const ready = Boolean(state.table.slipData) && !state.busy
  return `
    <div class="modal-back">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="table-pay-title">
        <p class="kicker">ชำระเงิน</p>
        <h2 id="table-pay-title">สแกนคิวอาร์เพื่อโอนเงิน</h2>
        ${state.error ? `<p class="alert">${esc(state.error)}</p>` : ''}
        <div class="line"><span>${count} โต๊ะ · รุ่น ${esc(state.table.generation)} · ${count * table.seats} ท่าน</span><span>${baht(tableTotal())}</span></div>
        ${paymentCard(tableTotal(), '')}
        <label class="btn btn-line slip-btn">
          ${state.table.slipData ? 'เปลี่ยนรูปสลิป' : 'แนบรูปสลิป'}
          <input type="file" accept="image/png,image/jpeg,image/webp" data-file="table">
        </label>
        ${state.table.slipData ? `<p class="fine">แนบแล้ว: ${esc(state.table.slipName)}</p><img class="slip-preview" alt="ตัวอย่างสลิป" src="${esc(state.table.slipData)}">` : '<p class="fine">โอนเสร็จแล้วแนบรูปสลิป ก่อนกดยืนยันการชำระเงิน</p>'}
        <div class="row-actions">
          <button class="btn btn-dark" type="button" data-action="confirm-table"${ready ? '' : ' disabled'}>${state.busy ? 'กำลังบันทึก' : 'ยืนยันการชำระเงิน'}</button>
          <button class="btn btn-line" type="button" data-action="close-table-pay">กลับไปแก้รายการ</button>
        </div>
      </div>
    </div>`
}

function lookupPage() {
  const result = state.lookup.shirts
  return `
    <main><div class="wrap">
      <div class="page-head">
        <p class="kicker">ตามเบอร์โทร</p>
        <h2>ตรวจสอบการจอง</h2>
      </div>
      ${state.error ? `<p class="alert">${esc(state.error)}</p>` : ''}
      <form class="panel" data-form="lookup">
        ${field('เบอร์โทรที่ใช้จอง', `<input id="lookup-phone" data-bind="lookup.phone" value="${esc(state.lookup.phone)}" inputmode="tel">`)}
        <button class="btn btn-dark" type="submit">ค้นหา</button>
      </form>
      ${result ? renderLookup() : ''}
    </div></main>`
}

function renderLookup() {
  const { shirts, tables } = state.lookup
  if (!shirts.length && !tables.length) return `<p class="panel">ยังไม่พบรายการของเบอร์นี้</p>`
  const shirtCards = shirts.map((order) => orderCard(order, order.items.map((item) => `ขนาด ${item.size} × ${item.qty}`).join(', '))).join('')
  const tableCards = tables.map((order) => orderCard(order, `${order.tableCount} โต๊ะ · ${order.seats} ท่าน`)).join('')
  return `<div class="section">${shirtCards}${tableCards}</div>`
}

function orderCard(order, detail) {
  const canSlip = order.status !== 'cancelled'
  return `
    <article class="panel" style="margin-bottom:16px">
      <p class="kicker">${esc(order.code)}</p>
      <p><span class="pill ${esc(order.status)}">${statusText(order.status)}</span></p>
      <p>${esc(detail)}</p>
      <p class="total">${baht(order.total)}</p>
      <p class="fine">${when(order.createdAt)}${order.hasSlip ? ' · มีสลิปแล้ว' : ' · ยังไม่มีสลิป'}</p>
      ${canSlip ? `<label class="field"><span>${order.hasSlip ? 'เปลี่ยนสลิป' : 'อัปโหลดสลิป'}</span><input type="file" accept="image/png,image/jpeg,image/webp" data-slip-code="${esc(order.code)}"></label>` : ''}
      ${order.status !== 'cancelled' ? paymentCard(order.total, order.code) : ''}
    </article>`
}

function adminPage() {
  if (!state.admin.token) {
    return `
      <main><div class="wrap">
        <form class="panel" data-form="admin-login" style="max-width:460px;margin:40px auto">
          <p class="kicker">ผู้จัดงาน</p>
          <h2>ตรวจรายการจอง</h2>
          ${state.error ? `<p class="alert">${esc(state.error)}</p>` : ''}
          ${field('รหัสผู้จัดงาน', `<input id="admin-password" type="password" data-bind="admin.password" autocomplete="current-password">`)}
          <button class="btn btn-dark" type="submit">เข้าสู่ระบบ</button>
        </form>
      </div></main>`
  }
  const data = state.admin.bookings
  if (!data) return `<main><div class="wrap loading">กำลังโหลดรายการ</div></main>`
  return `
    <main><div class="wrap">
      <div class="page-head">
        <p class="kicker">ผู้จัดงาน</p>
        <h2>รายการจองทั้งหมด</h2>
        <button class="btn btn-line no-print" type="button" data-action="logout">ออกจากระบบ</button>
      </div>
      ${state.error ? `<p class="alert">${esc(state.error)}</p>` : ''}
      ${adminStats(data)}
      <div class="filters">
        ${['pending', 'confirmed', 'cancelled', 'all'].map((item) => `<button class="btn btn-line" type="button" data-action="filter" data-filter="${item}" aria-pressed="${state.admin.filter === item}">${item === 'all' ? 'ทั้งหมด' : statusText(item)}</button>`).join('')}
        <button class="btn btn-line" type="button" data-action="export">ส่งออก CSV</button>
        <button class="btn btn-line" type="button" data-action="export-pdf">ส่งออก PDF</button>
        <button class="btn btn-line" type="button" data-action="sheets-sync">ซิงก์ไป Google Sheets</button>
      </div>
      <section class="panel"><h3>เสื้อ</h3>${bookingTable('shirt', data.shirts)}</section>
      <section class="panel" style="margin-top:16px"><h3>โต๊ะ</h3>${bookingTable('table', data.tables)}</section>
    </div></main>`
}

function adminStats(data) {
  const shirts = data.shirts.filter((row) => row.status !== 'cancelled')
  const tables = data.tables.filter((row) => row.status !== 'cancelled')
  const tally = {}
  shirts.forEach((row) => row.items.forEach((item) => { tally[item.size] = (tally[item.size] || 0) + item.qty }))
  const sizeText = state.catalog.shirt.sizes.map((size) => `${size} ${tally[size] || 0}`).join(' · ')
  return `
    <div class="admin-stats">
      <article class="stat"><p class="kicker">เสื้อที่สั่ง</p><p class="total">${shirts.reduce((sum, row) => sum + row.items.reduce((inner, item) => inner + item.qty, 0), 0)}</p><p>${esc(sizeText)}</p></article>
      <article class="stat"><p class="kicker">โต๊ะที่จอง</p><p class="total">${tables.reduce((sum, row) => sum + row.tableCount, 0)}</p></article>
      <article class="stat"><p class="kicker">ยอดรอตรวจ</p><p class="total">${baht([...shirts, ...tables].filter((row) => row.status === 'pending').reduce((sum, row) => sum + row.total, 0))}</p></article>
    </div>`
}

function bookingTable(kind, rows) {
  const visible = filteredAdminRows(rows)
  if (!visible.length) return `<p class="fine">ไม่มีรายการในสถานะนี้</p>`
  const body = visible.map((row) => {
    const who = kind === 'shirt' ? row.name : row.hostName
    const detail = kind === 'shirt'
      ? row.items.map((item) => `${item.size}×${item.qty}`).join(', ')
      : `${row.tableCount} โต๊ะ`
    const slip = row.slipData ? `<img class="slip-preview" alt="สลิป ${esc(row.code)}" src="${esc(row.slipData)}">` : 'ไม่มีสลิป'
    return `<tr>
      <td>${esc(row.code)}<br><span class="pill ${esc(row.status)}">${statusText(row.status)}</span></td>
      <td>${esc(who)}<br>${esc(row.generation)}<br>${esc(row.phone)}</td>
      <td>${esc(detail)}<br>${baht(row.total)}${row.address ? `<br>${esc(row.address)}` : ''}<br><span class="fine">${esc(row.guests || '')} ${esc(row.note || '')}</span></td>
      <td>${slip}</td>
      <td class="admin-actions">
        <button class="btn btn-line" type="button" data-action="status" data-kind="${kind}" data-id="${esc(row.id)}" data-status="confirmed">ยืนยัน</button>
        <button class="btn btn-line" type="button" data-action="status" data-kind="${kind}" data-id="${esc(row.id)}" data-status="cancelled">ยกเลิก</button>
      </td>
    </tr>`
  }).join('')
  return `<div class="table-wrap"><table><thead><tr><th>รหัส</th><th>ผู้จอง</th><th>รายการ</th><th>สลิป</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`
}

function mountQrs() {
  document.querySelectorAll('[data-qr]').forEach((el) => {
    try {
      const qr = window.qrcode(0, 'M')
      qr.addData(el.dataset.qr)
      qr.make()
      el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true, title: 'คิวอาร์ชำระเงิน' })
    } catch {
      el.innerHTML = '<p class="fine">สร้างคิวอาร์ไม่สำเร็จ</p>'
    }
  })
}

function toast(message) {
  let el = document.getElementById('toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'toast'
    document.body.appendChild(el)
  }
  el.textContent = message
  el.classList.add('show')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => el.classList.remove('show'), 1600)
}

function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(value).then(() => toast('คัดลอกแล้ว')).catch(() => fallbackCopy(value))
    return
  }
  fallbackCopy(value)
}

function fallbackCopy(value) {
  const input = document.createElement('textarea')
  input.value = value
  document.body.appendChild(input)
  input.select()
  document.execCommand('copy')
  input.remove()
  toast('คัดลอกแล้ว')
}

function downloadQr(payload, name) {
  const qr = window.qrcode(0, 'M')
  qr.addData(payload)
  qr.make()
  const link = document.createElement('a')
  link.href = qr.createDataURL(10, 12)
  link.download = `qr-${name}.png`
  link.click()
}

function bindValue(el) {
  if (!el.dataset.bind) return
  const [group, key] = el.dataset.bind.split('.')
  state[group][key] = el.type === 'checkbox' ? el.checked : el.value
}

function readSlip(file, apply) {
  if (!file) return
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name || '')) {
    state.error = 'รองรับเฉพาะไฟล์ PNG, JPG หรือ WEBP'
    render(true)
    return
  }
  const reader = new FileReader()
  reader.onerror = () => {
    state.error = 'อ่านไฟล์สลิปไม่สำเร็จ'
    render(true)
  }
  reader.onload = () => {
    const source = new Image()
    source.onload = () => {
      const maxSide = 1600
      const scale = Math.min(1, maxSide / Math.max(source.width, source.height))
      const width = Math.max(1, Math.round(source.width * scale))
      const height = Math.max(1, Math.round(source.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d').drawImage(source, 0, 0, width, height)
      let quality = 0.88
      let dataUrl = canvas.toDataURL('image/jpeg', quality)
      while (dataUrl.length > 1_800_000 && quality > 0.5) {
        quality -= 0.08
        dataUrl = canvas.toDataURL('image/jpeg', quality)
      }
      if (dataUrl.length > 2_200_000) {
        state.error = 'ไฟล์สลิปใหญ่เกินไป กรุณาเลือกรูปที่ชัดขึ้นแต่ขนาดเล็กลง'
        render(true)
        return
      }
      apply(dataUrl, (file.name || 'slip').replace(/\.\w+$/, '') + '.jpg')
    }
    source.onerror = () => {
      state.error = 'เปิดรูปสลิปไม่สำเร็จ'
      render(true)
    }
    source.src = String(reader.result)
  }
  reader.readAsDataURL(file)
}

function fail(message) {
  state.error = message
  render(true)
  document.querySelector('.alert')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

async function placeShirtOrder() {
  const form = state.shirt
  const items = shirtLines().map(([size, qty]) => ({ size, qty }))
  if (!items.length) return fail('กรุณาเลือกไซส์และจำนวนเสื้อ')
  state.busy = true
  state.error = ''
  render(true)
  try {
    const data = await api('/api/shirts', {
      method: 'POST',
      body: JSON.stringify({
        name: form.name,
        phone: phoneDigits(form.phone),
        address: form.address,
        items,
        slipData: form.slipData,
        slipName: form.slipName,
      }),
    })
    const order = data.order
    state.shirt = blankShirt()
    state.shirt.success = order
    state.catalog = await api('/api/public')
  } catch (error) {
    state.error = error.message
    state.shirt.payOpen = true
  } finally {
    state.busy = false
    render()
    window.scrollTo(0, 0)
  }
}

function goShirtInfo(event) {
  event.preventDefault()
  document.querySelectorAll('[data-bind^="shirt."]').forEach(bindValue)
  const form = state.shirt
  if (form.name.trim().length < 2) return fail('กรุณากรอกชื่อ-นามสกุล')
  if (!validPhone(form.phone)) return fail('กรุณากรอกเบอร์โทรให้ถูกต้อง')
  if (form.address.trim().length < 8) return fail('กรุณากรอกที่อยู่')
  state.error = ''
  state.shirt.step = 2
  render()
  window.scrollTo(0, 0)
}

function openShirtPay(event) {
  event.preventDefault()
  document.querySelectorAll('[data-qty-size]').forEach((el) => setShirtQty(el.dataset.qtySize, el.value))
  if (!shirtLines().length) return fail('กรุณาใส่จำนวนอย่างน้อย 1 ตัว')
  state.error = ''
  state.shirt.payOpen = true
  render()
}

function cohortFromId(value) {
  const numbers = digits(value)
  if (numbers.length >= 2) return numbers.slice(0, 2)
  return ''
}

function openTablePay(event) {
  event.preventDefault()
  document.querySelectorAll('[data-bind^="table."]').forEach(bindValue)
  const form = state.table
  const cohort = cohortFromId(form.generation)
  if (!state.catalog.tableOpen) return fail('ปิดรับจองโต๊ะแล้ว')
  if (form.hostName.trim().length < 2) return fail('กรุณากรอกชื่อ-นามสกุล')
  if (!validPhone(form.phone)) return fail('กรุณากรอกเบอร์โทรให้ถูกต้อง')
  if (form.address.trim().length < 8) return fail('กรุณากรอกที่อยู่')
  if (!cohort) return fail('ระบุรุ่น 2 หลักแรกของรหัสนิสิต เช่น รหัส 5103123 ให้ใส่ 51')
  form.generation = cohort
  state.error = ''
  state.table.payOpen = true
  render()
}

async function placeTableOrder() {
  const form = state.table
  if (!form.slipData) {
    state.error = 'กรุณาแนบรูปสลิปก่อนยืนยันการชำระเงิน'
    render(true)
    return
  }
  state.busy = true
  state.error = ''
  render(true)
  try {
    const data = await api('/api/tables', {
      method: 'POST',
      body: JSON.stringify({
        hostName: form.hostName,
        generation: form.generation,
        phone: phoneDigits(form.phone),
        address: form.address,
        tableCount: form.count,
        slipData: form.slipData,
        slipName: form.slipName,
      }),
    })
    const booking = data.booking
    state.table = blankTable()
    state.table.success = booking
    state.catalog = await api('/api/public')
  } catch (error) {
    state.error = error.message
    state.table.payOpen = true
  } finally {
    state.busy = false
    render()
    window.scrollTo(0, 0)
  }
}

async function submitLookup(event) {
  event.preventDefault()
  document.querySelectorAll('[data-bind^="lookup."]').forEach(bindValue)
  if (!validPhone(state.lookup.phone)) return fail('กรุณากรอกเบอร์โทรให้ถูกต้อง')
  state.error = ''
  try {
    const data = await api('/api/lookup', {
      method: 'POST',
      body: JSON.stringify({ phone: phoneDigits(state.lookup.phone) }),
    })
    state.lookup.shirts = data.shirts
    state.lookup.tables = data.tables
    render(true)
  } catch (error) {
    fail(error.message)
  }
}

async function submitAdmin(event) {
  event.preventDefault()
  document.querySelectorAll('[data-bind^="admin."]').forEach(bindValue)
  try {
    const data = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: state.admin.password }),
    })
    state.admin.token = data.token
    sessionStorage.setItem('niti-admin', data.token)
    state.error = ''
    await loadAdmin()
  } catch (error) {
    state.error = error.message
    render(true)
  }
}

async function loadAdmin() {
  const data = await api('/api/admin/bookings', { headers: { 'X-Admin-Token': state.admin.token } })
  state.admin.bookings = data
  render()
}

function exportCsv() {
  const data = state.admin.bookings
  if (!data) return
  const rows = [['ประเภท', 'รหัส', 'สถานะ', 'ชื่อ', 'รุ่น', 'เบอร์', 'รายการ', 'ยอด', 'ที่อยู่', 'หมายเหตุ', 'เวลา']]
  filteredAdminRows(data.shirts).forEach((row) => rows.push(['เสื้อ', row.code, statusText(row.status), row.name, row.generation, row.phone, row.items.map((item) => `${item.size}x${item.qty}`).join(' '), row.total, row.address || '', row.note || '', row.createdAt]))
  filteredAdminRows(data.tables).forEach((row) => rows.push(['โต๊ะ', row.code, statusText(row.status), row.hostName, row.generation, row.phone, `${row.tableCount} โต๊ะ`, row.total, row.address || '', row.note || '', row.createdAt]))
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
  downloadBlob(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }), 'bookings.csv')
  toast('ส่งออก CSV แล้ว')
}

function filteredAdminRows(rows) {
  return rows.filter((row) => state.admin.filter === 'all' || row.status === state.admin.filter).slice().reverse()
}

function adminPdfLines(data) {
  const shirts = filteredAdminRows(data.shirts)
  const tables = filteredAdminRows(data.tables)
  const filterLabel = state.admin.filter === 'all' ? 'ทั้งหมด' : statusText(state.admin.filter)
  const lines = [
    { text: state.catalog.event.faculty, style: 'kicker' },
    { text: 'รายการจองทั้งหมด', style: 'title' },
    { text: `${state.catalog.event.name} · ${state.catalog.event.theme}`, style: 'muted' },
    { text: `สถานะที่ส่งออก: ${filterLabel} · ${when(new Date().toISOString())}`, style: 'muted' },
    { text: `เสื้อ ${shirts.length} รายการ · โต๊ะ ${tables.length} รายการ`, style: 'body' },
    { text: '', style: 'gap' },
    { text: 'เสื้อที่ระลึก', style: 'section' },
  ]
  if (!shirts.length) lines.push({ text: 'ไม่มีรายการเสื้อในสถานะนี้', style: 'muted' })
  shirts.forEach((row) => {
    lines.push({
      text: `${row.code} · ${statusText(row.status)} · ${row.name} · ${row.phone}`,
      style: 'row',
    })
    lines.push({
      text: `${row.items.map((item) => `${item.size}×${item.qty}`).join(' · ')} · ${baht(row.total)}${row.address ? ` · ${row.address}` : ''}`,
      style: 'detail',
    })
  })
  lines.push({ text: '', style: 'gap' })
  lines.push({ text: 'โต๊ะจีน', style: 'section' })
  if (!tables.length) lines.push({ text: 'ไม่มีรายการโต๊ะในสถานะนี้', style: 'muted' })
  tables.forEach((row) => {
    lines.push({
      text: `${row.code} · ${statusText(row.status)} · ${row.hostName} · รุ่น ${row.generation || '-'} · ${row.phone}`,
      style: 'row',
    })
    lines.push({
      text: `${row.tableCount} โต๊ะ · ${row.seats} ท่าน · ${baht(row.total)}${row.address ? ` · ${row.address}` : ''}`,
      style: 'detail',
    })
  })
  return lines
}

async function syncGoogleSheets() {
  if (!state.admin.token) return
  state.busy = true
  state.error = ''
  render(true)
  try {
    const data = await api('/api/admin/sheets-sync', {
      method: 'POST',
      headers: { 'X-Admin-Token': state.admin.token },
      body: '{}',
    })
    toast(`ซิงก์ Google Sheets แล้ว ${data.count || 0} รายการ`)
  } catch (error) {
    state.error = error.message
    toast(error.message)
  } finally {
    state.busy = false
    render(true)
  }
}

async function exportBookingsPdf() {
  const data = state.admin.bookings
  if (!data) return
  try {
    await document.fonts.ready
    const content = adminPdfLines(data)
    const pageWidth = 1240
    const pageHeight = 1754
    const margin = 56
    const pages = []
    let canvas = document.createElement('canvas')
    canvas.width = pageWidth
    canvas.height = pageHeight
    let ctx = canvas.getContext('2d')
    let y = 0

    const startPage = () => {
      canvas = document.createElement('canvas')
      canvas.width = pageWidth
      canvas.height = pageHeight
      ctx = canvas.getContext('2d')
      ctx.fillStyle = '#f7f3ea'
      ctx.fillRect(0, 0, pageWidth, pageHeight)
      ctx.fillStyle = '#10241c'
      ctx.fillRect(0, 0, pageWidth, 18)
      y = 70
    }

    const finishPage = () => {
      pages.push({
        jpegBytes: dataUrlToBytes(canvas.toDataURL('image/jpeg', 0.92)),
        width: pageWidth,
        height: pageHeight,
      })
    }

    const drawLine = (item) => {
      const styles = {
        kicker: { font: '600 24px Sarabun, Thonburi, sans-serif', color: '#c6a15b', gap: 34 },
        title: { font: '600 44px "Noto Serif Thai", Thonburi, serif', color: '#1c2822', gap: 54 },
        section: { font: '700 30px Sarabun, Thonburi, sans-serif', color: '#10241c', gap: 42 },
        body: { font: '600 24px Sarabun, Thonburi, sans-serif', color: '#1c2822', gap: 36 },
        row: { font: '600 24px Sarabun, Thonburi, sans-serif', color: '#1c2822', gap: 32 },
        detail: { font: '400 22px Sarabun, Thonburi, sans-serif', color: '#5d6b63', gap: 34 },
        muted: { font: '400 22px Sarabun, Thonburi, sans-serif', color: '#5d6b63', gap: 32 },
        gap: { font: '400 22px Sarabun, Thonburi, sans-serif', color: '#5d6b63', gap: 24 },
      }
      const style = styles[item.style] || styles.body
      ctx.font = style.font
      if (!item.text) {
        y += style.gap
        return
      }
      const wrapped = wrapCanvasText(ctx, item.text, pageWidth - margin * 2)
      const lineHeight = style.gap - 6
      if (y + wrapped.length * lineHeight > pageHeight - margin) {
        finishPage()
        startPage()
        ctx.font = style.font
      }
      ctx.fillStyle = style.color
      ctx.textAlign = 'left'
      wrapped.forEach((line) => {
        ctx.fillText(line, margin, y)
        y += lineHeight
      })
      y += 10
    }

    startPage()
    content.forEach(drawLine)
    finishPage()
    const pdf = imagesToPdf(pages)
    const stamp = new Date().toISOString().slice(0, 10)
    downloadBlob(new Blob([pdf], { type: 'application/pdf' }), `รายการจอง-${stamp}.pdf`)
    toast('ส่งออก PDF แล้ว')
  } catch {
    toast('ส่งออก PDF ไม่สำเร็จ')
  }
}

function onClick(event) {
  const el = event.target.closest('[data-action]')
  if (!el) return
  const action = el.dataset.action
  if (action === 'reload') {
    loadCatalog()
    return
  }
  if (action === 'copy') {
    copyText(el.dataset.value || '')
    return
  }
  if (action === 'download-qr') {
    downloadQr(el.dataset.payload, el.dataset.name)
    return
  }
  if (action === 'qty') {
    const size = el.dataset.size
    setShirtQty(size, (state.shirt.items[size] || 0) + Number(el.dataset.dir))
    state.error = ''
    render(true)
    return
  }
  if (action === 'shirt-back') {
    state.shirt.step = 1
    state.shirt.payOpen = false
    state.error = ''
    render()
    return
  }
  if (action === 'close-pay') {
    state.shirt.payOpen = false
    state.error = ''
    render()
    return
  }
  if (action === 'close-table-pay') {
    state.table.payOpen = false
    state.error = ''
    render()
    return
  }
  if (action === 'confirm-table') {
    placeTableOrder()
    return
  }
  if (action === 'save-receipt') {
    saveReceiptImage(el.dataset.kind)
    return
  }
  if (action === 'save-receipt-pdf') {
    saveReceiptPdf(el.dataset.kind)
    return
  }
  if (action === 'confirm-transfer') {
    placeShirtOrder()
    return
  }
  if (action === 'print') {
    window.print()
    return
  }
  if (action === 'tables') {
    const cap = state.catalog.table.maxPerOrder
    state.table.count = Math.min(cap, Math.max(1, state.table.count + Number(el.dataset.dir)))
    render(true)
    return
  }
  if (action === 'clear-slip') {
    state[el.dataset.group].slipData = ''
    state[el.dataset.group].slipName = ''
    render(true)
    return
  }
  if (action === 'again') {
    state[el.dataset.kind] = el.dataset.kind === 'shirt' ? blankShirt() : blankTable()
    state.error = ''
    render()
    return
  }
  if (action === 'filter') {
    state.admin.filter = el.dataset.filter
    render()
    return
  }
  if (action === 'export') {
    exportCsv()
    return
  }
  if (action === 'export-pdf') {
    exportBookingsPdf()
    return
  }
  if (action === 'sheets-sync') {
    syncGoogleSheets()
    return
  }
  if (action === 'logout') {
    state.admin.token = ''
    state.admin.bookings = null
    sessionStorage.removeItem('niti-admin')
    render()
    return
  }
  if (action === 'status') {
    updateStatus(el.dataset.kind, el.dataset.id, el.dataset.status)
  }
}

function setShirtQty(size, raw) {
  const qty = Math.min(SHIRT_MAX, Math.max(0, Number.parseInt(raw, 10) || 0))
  if (qty === 0) delete state.shirt.items[size]
  else state.shirt.items[size] = qty
}

function wrapCanvasText(ctx, text, maxWidth) {
  const lines = []
  let line = ''
  Array.from(String(text || '')).forEach((ch) => {
    const next = line + ch
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line)
      line = ch
    } else {
      line = next
    }
  })
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

async function buildReceiptCanvas(kind) {
  const order = state[kind] && state[kind].success
  if (!order) return null
  await document.fonts.ready
  const model = receiptModel(kind, order)
  const canvas = document.createElement('canvas')
  const width = 900
  const ctx = canvas.getContext('2d')
  ctx.font = '400 28px Sarabun, Thonburi, sans-serif'
  const fieldLines = model.fields.flatMap(([label, value]) => {
    const wrapped = wrapCanvasText(ctx, value, 760)
    return [[label, wrapped[0]], ...wrapped.slice(1).map((line) => ['', line])]
  })
  const height = 250 + fieldLines.length * 46 + model.lines.length * 52 + 120
  canvas.width = width * 2
  canvas.height = height * 2
  ctx.scale(2, 2)
  ctx.fillStyle = '#f7f3ea'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#10241c'
  ctx.fillRect(0, 0, width, 16)
  ctx.fillStyle = '#c6a15b'
  ctx.font = '600 22px Sarabun, Thonburi, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(model.eventLine, width / 2, 70)
  ctx.fillStyle = '#1c2822'
  ctx.font = '600 42px "Noto Serif Thai", Thonburi, serif'
  ctx.fillText(model.title, width / 2, 126)
  ctx.font = '400 22px Sarabun, Thonburi, sans-serif'
  ctx.fillStyle = '#5d6b63'
  ctx.fillText(model.themeLine, width / 2, 164)
  ctx.fillStyle = '#1c2822'
  ctx.font = '700 40px Sarabun, Thonburi, sans-serif'
  ctx.fillText(model.code, width / 2, 220)
  ctx.strokeStyle = '#d9d0c0'
  ctx.beginPath()
  ctx.moveTo(48, 248)
  ctx.lineTo(width - 48, 248)
  ctx.stroke()
  ctx.textAlign = 'left'
  ctx.font = '400 26px Sarabun, Thonburi, sans-serif'
  let y = 300
  fieldLines.forEach(([label, value]) => {
    ctx.fillStyle = '#5d6b63'
    ctx.fillText(label, 56, y)
    ctx.fillStyle = '#1c2822'
    ctx.fillText(value, 220, y)
    y += 46
  })
  y += 8
  ctx.beginPath()
  ctx.moveTo(48, y)
  ctx.lineTo(width - 48, y)
  ctx.stroke()
  y += 48
  model.lines.forEach(([label, value], index) => {
    ctx.fillStyle = '#1c2822'
    ctx.font = index === model.lines.length - 1 ? '700 28px Sarabun, Thonburi, sans-serif' : '400 26px Sarabun, Thonburi, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(label, 56, y)
    ctx.textAlign = 'right'
    ctx.fillText(value, width - 56, y)
    y += 52
  })
  ctx.textAlign = 'left'
  ctx.font = '400 22px Sarabun, Thonburi, sans-serif'
  ctx.fillStyle = '#5d6b63'
  wrapCanvasText(ctx, model.note, 780).forEach((line) => {
    y += 36
    ctx.fillText(line, 56, y)
  })
  return { canvas, model, width, height }
}

function dataUrlToBytes(dataUrl) {
  const raw = atob(dataUrl.split(',')[1] || '')
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function jpegToPdf(jpegBytes, pixelWidth, pixelHeight) {
  return imagesToPdf([{ jpegBytes, width: pixelWidth, height: pixelHeight }])
}

function imagesToPdf(pages) {
  if (!pages.length) throw new Error('empty-pdf')
  const pageWidth = 595.28
  const encoder = new TextEncoder()
  const parts = []
  const offsets = [0]
  let length = 0
  const push = (chunk) => {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
    parts.push(bytes)
    length += bytes.length
  }

  const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(' ')
  push('%PDF-1.4\n')
  offsets.push(length)
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  offsets.push(length)
  push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`)

  pages.forEach((page, index) => {
    const pageObj = 3 + index * 3
    const imageObj = pageObj + 1
    const contentObj = pageObj + 2
    const pageHeight = Math.max(200, pageWidth * (page.height / page.width))
    const content = `q\n${pageWidth.toFixed(2)} 0 0 ${pageHeight.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`
    offsets.push(length)
    push(
      `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] `
      + `/Resources << /XObject << /Im0 ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`,
    )
    offsets.push(length)
    push(
      `${imageObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} `
      + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpegBytes.length} >>\nstream\n`,
    )
    push(page.jpegBytes)
    push('\nendstream\nendobj\n')
    offsets.push(length)
    push(`${contentObj} 0 obj\n<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`)
  })

  const xrefStart = length
  const objectCount = 2 + pages.length * 3
  push(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`)
  for (let i = 1; i <= objectCount; i += 1) {
    push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  }
  push(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`)

  const pdf = new Uint8Array(length)
  let offset = 0
  parts.forEach((part) => {
    pdf.set(part, offset)
    offset += part.length
  })
  return pdf
}

function downloadBlob(blob, filename) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}

async function saveReceiptImage(kind) {
  try {
    const built = await buildReceiptCanvas(kind)
    if (!built) return
    const link = document.createElement('a')
    link.href = built.canvas.toDataURL('image/png')
    link.download = `ใบยืนยัน-${built.model.code}.png`
    link.click()
    toast('บันทึกรูปใบยืนยันแล้ว')
  } catch {
    toast('บันทึกรูปไม่สำเร็จ')
  }
}

async function saveReceiptPdf(kind) {
  try {
    const built = await buildReceiptCanvas(kind)
    if (!built) return
    const jpeg = dataUrlToBytes(built.canvas.toDataURL('image/jpeg', 0.92))
    const pdf = jpegToPdf(jpeg, built.canvas.width, built.canvas.height)
    downloadBlob(new Blob([pdf], { type: 'application/pdf' }), `ใบยืนยัน-${built.model.code}.pdf`)
    toast('บันทึก PDF ใบยืนยันแล้ว')
  } catch {
    toast('บันทึก PDF ไม่สำเร็จ')
  }
}

function onInput(event) {
  const el = event.target
  if (el.dataset.qtySize) {
    setShirtQty(el.dataset.qtySize, el.value)
    render(true)
    return
  }
  if (!el.dataset.bind || el.type === 'checkbox' || el.type === 'radio') return
  bindValue(el)
}

function onChange(event) {
  const el = event.target
  if (el.dataset.bind) {
    bindValue(el)
    if (el.dataset.bind.endsWith('pickup') || el.type === 'checkbox') render(true)
  }
  if (el.dataset.file) {
    readSlip(el.files[0], (slipData, slipName) => {
      state[el.dataset.file].slipData = slipData
      state[el.dataset.file].slipName = slipName
      state.error = ''
      render(true)
    })
  }
  if (el.dataset.slipCode) {
    readSlip(el.files[0], async (slipData, slipName) => {
      try {
        await api('/api/slip', {
          method: 'POST',
          body: JSON.stringify({
            code: el.dataset.slipCode,
            phone: phoneDigits(state.lookup.phone),
            slipData,
            slipName,
          }),
        })
        toast('แนบสลิปแล้ว')
        const data = await api('/api/lookup', { method: 'POST', body: JSON.stringify({ phone: phoneDigits(state.lookup.phone) }) })
        state.lookup.shirts = data.shirts
        state.lookup.tables = data.tables
        render(true)
      } catch (error) {
        fail(error.message)
      }
    })
  }
}

function onSubmit(event) {
  const form = event.target.closest('form')
  if (!form) return
  if (form.dataset.form === 'shirt-info') goShirtInfo(event)
  if (form.dataset.form === 'shirt-sizes') openShirtPay(event)
  if (form.dataset.form === 'table') openTablePay(event)
  if (form.dataset.form === 'lookup') submitLookup(event)
  if (form.dataset.form === 'admin-login') submitAdmin(event)
}

async function updateStatus(kind, id, status) {
  try {
    await api('/api/admin/status', {
      method: 'POST',
      headers: { 'X-Admin-Token': state.admin.token },
      body: JSON.stringify({ kind, id, status }),
    })
    await loadAdmin()
  } catch (error) {
    if (String(error.message).includes('รหัสผู้ดูแล')) {
      state.admin.token = ''
      sessionStorage.removeItem('niti-admin')
    }
    state.error = error.message
    render()
  }
}

async function loadCatalog() {
  state.loadError = ''
  try {
    state.catalog = await api('/api/public')
  } catch (error) {
    state.loadError = error.message
    render()
    return
  }
  if (state.page === 'admin' && state.admin.token) {
    try {
      await loadAdmin()
    } catch {
      state.admin.token = ''
      state.admin.bookings = null
      sessionStorage.removeItem('niti-admin')
      state.error = 'เข้าระบบผู้จัดงานอีกครั้ง'
      render()
    }
    return
  }
  render()
}

function boot() {
  const root = document.getElementById('app')
  root.addEventListener('click', onClick)
  root.addEventListener('input', onInput)
  root.addEventListener('change', onChange)
  root.addEventListener('submit', onSubmit)
  window.addEventListener('hashchange', () => {
    state.page = readPage()
    state.error = ''
    if (state.page === 'admin' && state.admin.token && !state.admin.bookings) loadAdmin()
    else render()
    window.scrollTo(0, 0)
  })
  loadCatalog()
}

boot()
