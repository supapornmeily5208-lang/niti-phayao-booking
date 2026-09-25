function tlv(id, value) {
  const text = String(value)
  return id + String(text.length).padStart(2, '0') + text
}

function crc16(payload) {
  let crc = 0xffff
  for (let i = 0; i < payload.length; i += 1) {
    crc ^= payload.charCodeAt(i) << 8
    for (let bit = 0; bit < 8; bit += 1) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021
      else crc <<= 1
      crc &= 0xffff
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

function promptPayField(id) {
  const digits = String(id).replace(/\D/g, '')
  if (digits.length >= 13) return tlv('02', digits)
  const phone = ('0066' + digits.replace(/^0/, '')).padStart(13, '0')
  return tlv('01', phone)
}

export function buildPayload({ bankCode, accountNumber, promptPay, amount, reference }) {
  const target = promptPay
    ? promptPayField(promptPay)
    : tlv('04', String(bankCode) + String(accountNumber).replace(/\D/g, ''))
  const hasAmount = typeof amount === 'number' && amount > 0
  const ref = String(reference || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 20)
  const merchant = tlv('00', 'A000000677010111') + target
  let body = tlv('00', '01') + tlv('01', hasAmount ? '12' : '11') + tlv('29', merchant)
  body += tlv('53', '764')
  if (hasAmount) body += tlv('54', amount.toFixed(2))
  body += tlv('58', 'TH')
  if (ref) body += tlv('62', tlv('01', ref))
  body += '6304'
  return body + crc16(body)
}
