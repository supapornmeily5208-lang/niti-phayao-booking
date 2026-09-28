/**
 * สคริปต์เชื่อมเว็บจอง → Google Sheets
 *
 * วิธีใช้:
 * 1. เปิด Google Sheets ของงานนี้
 * 2. ส่วนขยาย → Apps Script แล้ววางโค้ดนี้ทั้งไฟล์ บันทึก
 * 3. นำส่ง → การนำไปใช้ใหม่ → ประเภท: เว็บแอป
 *    - เรียกใช้เป็น: ฉัน
 *    - ผู้มีสิทธิ์เข้าถึง: ทุกคน
 * 4. คัดลอกลิงก์เว็บแอป ไปใส่ใน Render ชื่อตัวแปร SHEETS_WEBHOOK_URL
 * 5. ในหน้าผู้จัดงาน กด "ซิงก์ไป Google Sheets" หรือ "ดึงจาก Google Sheets"
 *
 * หมายเหตุ: ชีทเป็นแบ็กอัพรายการ (ไม่มีไฟล์สลิป) เว็บจะดึงกลับอัตโนมัติตอนสตาร์ทเซิร์ฟเวอร์
 */

var SHEET_SHIRTS = 'จองเสื้อ'
var SHEET_TABLES = 'จองโต๊ะ'
var HEADERS_SHIRT = ['เวลาอัปเดต', 'รหัส', 'สถานะ', 'ชื่อ', 'เบอร์โทร', 'วิธีรับ', 'ที่อยู่', 'หมายเลขพัสดุ', 'รายการ', 'ยอด', 'มีสลิป', 'วันเวลาจอง']
var HEADERS_TABLE = ['เวลาอัปเดต', 'รหัส', 'สถานะ', 'ชื่อ', 'รุ่น', 'เบอร์โทร', 'ที่อยู่', 'จำนวนโต๊ะ', 'จำนวนท่าน', 'ยอด', 'มีสลิป', 'วันเวลาจอง']

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || ''
  if (action === 'export') {
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet()
      ensureSheet_(ss, SHEET_SHIRTS, HEADERS_SHIRT)
      ensureSheet_(ss, SHEET_TABLES, HEADERS_TABLE)
      return json_({
        ok: true,
        shirts: exportSheet_(ss.getSheetByName(SHEET_SHIRTS), HEADERS_SHIRT),
        tables: exportSheet_(ss.getSheetByName(SHEET_TABLES), HEADERS_TABLE),
      })
    } catch (err) {
      return json_({ ok: false, error: String(err) })
    }
  }
  return json_({ ok: true, service: 'niti-phayao-sheets' })
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents)
    var ss = SpreadsheetApp.getActiveSpreadsheet()
    ensureSheet_(ss, SHEET_SHIRTS, HEADERS_SHIRT)
    ensureSheet_(ss, SHEET_TABLES, HEADERS_TABLE)

    if (data.action === 'sync' && data.rows instanceof Array) {
      data.rows.forEach(function (row) { upsert_(ss, row) })
      return json_({ ok: true, synced: data.rows.length })
    }

    upsert_(ss, data)
    return json_({ ok: true })
  } catch (err) {
    return json_({ ok: false, error: String(err) })
  }
}

function exportSheet_(sheet, headers) {
  var last = sheet.getLastRow()
  if (last < 2) return []
  var width = headers.length
  var values = sheet.getRange(2, 1, last - 1, width).getValues()
  var rows = []
  for (var i = 0; i < values.length; i++) {
    var obj = {}
    var empty = true
    for (var c = 0; c < width; c++) {
      var key = headers[c]
      var val = values[i][c]
      if (val !== '' && val !== null) empty = false
      obj[key] = val
    }
    if (!empty && obj['รหัส']) rows.push(obj)
  }
  return rows
}

function upsert_(ss, row) {
  if (!row || !row.kind || !row.code) return
  var isShirt = row.kind === 'shirt'
  var sheet = ss.getSheetByName(isShirt ? SHEET_SHIRTS : SHEET_TABLES)
  var values = isShirt
    ? [
      row.updatedAt || '',
      row.code || '',
      row.status || '',
      row.name || '',
      row.phone || '',
      row.pickup || '',
      row.address || '',
      row.trackingNumber || '',
      row.detail || '',
      row.total || '',
      row.slipStatus || (row.hasSlip ? 'ใช่' : 'ไม่'),
      row.createdAt || '',
    ]
    : [
      row.updatedAt || '',
      row.code || '',
      row.status || '',
      row.name || '',
      row.generation || '',
      row.phone || '',
      row.address || '',
      row.tableCount || '',
      row.seats || '',
      row.total || '',
      row.slipStatus || (row.hasSlip ? 'ใช่' : 'ไม่'),
      row.createdAt || '',
    ]

  var last = sheet.getLastRow()
  if (last < 2) {
    sheet.appendRow(values)
    return
  }
  var codes = sheet.getRange(2, 2, last - 1, 1).getValues()
  var found = -1
  for (var i = 0; i < codes.length; i++) {
    if (String(codes[i][0]) === String(row.code)) {
      found = i + 2
      break
    }
  }
  if (found > 0) sheet.getRange(found, 1, 1, values.length).setValues([values])
  else sheet.appendRow(values)
}

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name)
  if (!sheet) sheet = ss.insertSheet(name)
  var width = Math.max(headers.length, sheet.getLastColumn() || headers.length)
  var first = sheet.getRange(1, 1, 1, width).getValues()[0]
  var blank = first.every(function (cell) { return cell === '' })
  var same = headers.every(function (h, i) { return String(first[i] || '') === String(h) })
  if (blank || !same) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
  }
  sheet.setFrozenRows(1)
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON)
}
