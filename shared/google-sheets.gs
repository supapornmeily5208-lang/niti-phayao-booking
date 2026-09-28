/**
 * สคริปต์เชื่อมเว็บจอง → Google Sheets + Google Drive (เก็บรูปสลิป)
 *
 * วิธีใช้ (สำคัญ: ต้องอัปเดตสคริปต์นี้แล้ว Deploy ใหม่):
 * 1. เปิด Google Sheets ของงานนี้
 * 2. ส่วนขยาย → Apps Script แล้ววางโค้ดนี้ทั้งไฟล์ บันทึก
 * 3. นำส่ง → จัดการการนำไปใช้ → แก้ไขการนำไปใช้ / สร้างเวอร์ชันใหม่
 *    หรือ การนำไปใช้ใหม่ → เว็บแอป
 *    - เรียกใช้เป็น: ฉัน
 *    - ผู้มีสิทธิ์เข้าถึง: ทุกคน
 * 4. คัดลอกลิงก์เว็บแอป ไปใส่ Render → SHEETS_WEBHOOK_URL
 * 5. หน้าผู้จัดงาน กด "ซิงก์ไป Google Sheets" เพื่ออัปรูปสลิปที่มีอยู่ขึ้น Drive
 *
 * สลิปจะถูกเก็บในโฟลเดอร์ Drive "นิติพะเยา-สลิป" และใส่ลิงก์ในคอลัมน์ "ลิงก์สลิป"
 */

var SHEET_SHIRTS = 'จองเสื้อ'
var SHEET_TABLES = 'จองโต๊ะ'
var SLIP_FOLDER = 'นิติพะเยา-สลิป'
var HEADERS_SHIRT = ['เวลาอัปเดต', 'รหัส', 'สถานะ', 'ชื่อ', 'เบอร์โทร', 'วิธีรับ', 'ที่อยู่', 'หมายเลขพัสดุ', 'รายการ', 'ยอด', 'มีสลิป', 'ลิงก์สลิป', 'วันเวลาจอง']
var HEADERS_TABLE = ['เวลาอัปเดต', 'รหัส', 'สถานะ', 'ชื่อ', 'รุ่น', 'เบอร์โทร', 'ที่อยู่', 'จำนวนโต๊ะ', 'จำนวนท่าน', 'ยอด', 'มีสลิป', 'ลิงก์สลิป', 'วันเวลาจอง']

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
  return json_({ ok: true, service: 'niti-phayao-sheets', slips: true })
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents)
    var ss = SpreadsheetApp.getActiveSpreadsheet()
    ensureSheet_(ss, SHEET_SHIRTS, HEADERS_SHIRT)
    ensureSheet_(ss, SHEET_TABLES, HEADERS_TABLE)

    if (data.action === 'sync' && data.rows instanceof Array) {
      var urls = []
      data.rows.forEach(function (row) {
        urls.push({ code: row.code || '', slipUrl: upsert_(ss, row) })
      })
      return json_({ ok: true, synced: data.rows.length, urls: urls })
    }

    var slipUrl = upsert_(ss, data)
    return json_({ ok: true, slipUrl: slipUrl || '', code: data.code || '' })
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
  if (!row || !row.kind || !row.code) return ''
  var isShirt = row.kind === 'shirt'
  var sheet = ss.getSheetByName(isShirt ? SHEET_SHIRTS : SHEET_TABLES)
  var slipUrl = String(row.slipUrl || '')
  if (row.slipData) {
    var saved = saveSlip_(row.code, row.slipData, row.slipName)
    if (saved) slipUrl = saved
  }
  var hasSlip = !!(slipUrl || row.hasSlip || row.slipData)
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
      row.slipStatus || (hasSlip ? 'ใช่' : 'ไม่'),
      slipUrl,
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
      row.slipStatus || (hasSlip ? 'ใช่' : 'ไม่'),
      slipUrl,
      row.createdAt || '',
    ]

  var last = sheet.getLastRow()
  if (last < 2) {
    sheet.appendRow(values)
    return slipUrl
  }
  var codes = sheet.getRange(2, 2, last - 1, 1).getValues()
  var found = -1
  for (var i = 0; i < codes.length; i++) {
    if (String(codes[i][0]) === String(row.code)) {
      found = i + 2
      break
    }
  }
  if (found > 0) {
    // ถ้ารายการเดิมมีลิงก์สลิปอยู่แล้ว และรอบนี้ไม่อัปโหลดใหม่ ให้คงลิงก์เดิม
    if (!slipUrl) {
      var oldUrl = String(sheet.getRange(found, 12).getValue() || '')
      if (oldUrl) {
        slipUrl = oldUrl
        values[11] = oldUrl
        if (!values[10] || values[10] === 'ไม่') values[10] = 'ใช่'
      }
    }
    sheet.getRange(found, 1, 1, values.length).setValues([values])
  } else {
    sheet.appendRow(values)
  }
  return slipUrl
}

function getSlipFolder_() {
  var folders = DriveApp.getFoldersByName(SLIP_FOLDER)
  if (folders.hasNext()) return folders.next()
  return DriveApp.createFolder(SLIP_FOLDER)
}

function saveSlip_(code, dataUrl, filename) {
  var raw = String(dataUrl || '')
  var match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i)
  if (!match) return ''
  var mime = match[1]
  var bytes = Utilities.base64Decode(match[2])
  var ext = mime.indexOf('png') >= 0 ? '.png' : mime.indexOf('webp') >= 0 ? '.webp' : '.jpg'
  var safeName = String(code || 'slip').replace(/[^\w\-]+/g, '_') + '-slip' + ext
  var blob = Utilities.newBlob(bytes, mime, filename || safeName)
  var folder = getSlipFolder_()
  var existing = folder.getFilesByName(safeName)
  while (existing.hasNext()) existing.next().setTrashed(true)
  // also trash old extension variants
  var variants = folder.getFilesByName(String(code || 'slip').replace(/[^\w\-]+/g, '_') + '-slip')
  while (variants.hasNext()) variants.next().setTrashed(true)
  var file = folder.createFile(blob)
  file.setName(safeName)
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW)
  return 'https://drive.google.com/uc?export=download&id=' + file.getId()
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
