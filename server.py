#!/usr/bin/env python3
"""เว็บจองเสื้อและจองโต๊ะ นิติพะเยา คืนสู่เหย้า

รัน: python3 server.py
เปิด: http://127.0.0.1:8080
รหัสผู้จัดงานค่าเริ่มต้น: phayao2569
เปลี่ยนรหัสได้ด้วยตัวแปรสภาพแวดล้อม ADMIN_PASSWORD
แก้รายละเอียดงาน ราคา และบัญชีได้ที่ shared/event.json แล้วรีเฟรชหน้าเว็บ
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import traceback
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", str(ROOT / "data")))
DATA = DATA_DIR / "db.json"
CATALOG = ROOT / "shared" / "event.json"
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "phayao2569")
SHEETS_WEBHOOK_URL = os.environ.get("SHEETS_WEBHOOK_URL", "").strip()
SHEETS_SPREADSHEET_ID = os.environ.get(
    "SHEETS_SPREADSHEET_ID",
    "1fpkUYP5fnJ3sdlPcPVNApKNqL49HQ4RV3JB_ol4MNbE",
).strip()
TOKEN = hmac.new(b"niti-phayao-reunion", ADMIN_PASSWORD.encode(), hashlib.sha256).hexdigest()
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
LOCK = __import__("threading").Lock()
STATUS_TH = {"pending": "รอตรวจสอบ", "confirmed": "ยืนยันแล้ว", "cancelled": "ยกเลิก"}
STATUS_FROM_TH = {value: key for key, value in STATUS_TH.items()}
STATUS_FROM_TH.update({"รอตรวจ": "pending", "ยืนยัน": "confirmed", "ยกเลิกแล้ว": "cancelled"})
SHIRT_SIZE_KEYS = ["7L", "5L", "3L", "2L", "XL", "XS", "L", "M", "S"]

FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/js/app.js": ("js/app.js", "text/javascript; charset=utf-8"),
    "/js/payload.js": ("js/payload.js", "text/javascript; charset=utf-8"),
    "/vendor/qrcode.js": ("vendor/qrcode.js", "text/javascript; charset=utf-8"),
    "/vendor/jsqr.js": ("vendor/jsqr.js", "text/javascript; charset=utf-8"),
    "/favicon.svg": ("public/favicon.svg", "image/svg+xml"),
    "/logo.jpg": ("public/logo.jpg", "image/jpeg"),
    "/shirt-sample.jpg": ("public/shirt-sample.jpg", "image/jpeg"),
    "/size-chart.jpg": ("public/size-chart.jpg", "image/jpeg"),
    "/payment-qr.png": ("public/payment-qr.png", "image/png"),
}


def load_catalog():
    return json.loads(CATALOG.read_text(encoding="utf-8"))


def load_db():
    if not DATA.exists():
        return {"shirts": [], "tables": []}
    return json.loads(DATA.read_text(encoding="utf-8"))


def save_db(db):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp = DATA.with_suffix(".json.tmp")
    temp.write_text(json.dumps(db, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(DATA)


def clean(value, limit):
    return str(value or "").strip()[:limit]


def phone_of(value):
    digits = re.sub(r"\D", "", str(value or ""))
    if digits.startswith("66") and len(digits) >= 11:
        digits = "0" + digits[2:]
    if len(digits) == 9 and not digits.startswith("0"):
        digits = "0" + digits
    return digits


def valid_phone(value):
    return re.fullmatch(r"0\d{8,9}", value) is not None


def valid_slip(data, required=False):
    if not data:
        return not required
    if not isinstance(data, str) or len(data) > 2_400_000:
        return False
    return re.match(r"^data:image/(png|jpe?g|jpg|webp)(;charset=[^;]+)?;base64,", data, re.I) is not None


def crc16(payload):
    crc = 0xFFFF
    for ch in payload:
        crc ^= ord(ch) << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return "%04X" % crc


def parse_tlv(data):
    result = {}
    i = 0
    while i + 4 <= len(data):
        tag = data[i : i + 2]
        try:
            length = int(data[i + 2 : i + 4])
        except ValueError:
            break
        if i + 4 + length > len(data):
            break
        value = data[i + 4 : i + 4 + length]
        result[tag] = value
        i += 4 + length
    return result


def find_amounts(text):
    found = []
    for match in re.finditer(r"(?<!\d)(\d{1,7}(?:\.\d{2})?)(?!\d)", str(text or "")):
        try:
            found.append(float(match.group(1)))
        except ValueError:
            continue
    return found


def account_matches(digits, payment, text=""):
    account = re.sub(r"\D", "", str(payment.get("accountNumber") or ""))
    bank_code = re.sub(r"\D", "", str(payment.get("bankCode") or ""))
    prompt_pay = re.sub(r"\D", "", str(payment.get("promptPay") or ""))
    raw = str(text or "")
    if account:
        if account in digits or (len(account) >= 6 and account[-6:] in digits) or (len(account) >= 4 and account[-4:] in digits):
            return True
        if bank_code and (bank_code + account) in digits:
            return True
    if prompt_pay and prompt_pay in digits:
        return True
    if prompt_pay and len(prompt_pay) >= 9:
        mobile = "0066" + prompt_pay.lstrip("0")
        if mobile in digits:
            return True
    name = str(payment.get("accountName") or "").strip()
    if name and name in raw:
        return True
    for hint in payment.get("slipHints") or []:
        hint = str(hint or "").strip()
        if hint and hint.lower() in raw.lower():
            return True
    return False


def verify_slip_qr(qr_text, expected_amount, payment):
    """ตรวจว่าเป็นสลิป (มีคิวอาร์) — ผ่านแล้วรอผู้จัดงานยืนยัน ไม่ auto-confirm"""
    text = str(qr_text or "").strip()
    result = {
        "ok": False,
        "autoConfirm": False,
        "method": "",
        "reason": "",
        "amount": None,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
    }
    if not text:
        result["reason"] = "รูปที่แนบไม่ใช่สลิป หรือไม่พบคิวอาร์ กรุณาแนบสลิปใหม่ให้เห็นคิวอาร์ชัดเจน"
        return result

    digits = re.sub(r"\D", "", text)
    amount = None
    crc_ok = None
    emv = text.startswith("000201") or (len(text) >= 8 and text[-8:-4] == "6304")

    if emv and len(text) >= 8 and text[-8:-4] == "6304":
        crc_ok = crc16(text[:-4]) == text[-4:].upper()
        tags = parse_tlv(text[:-8])
        if "54" in tags:
            try:
                amount = float(tags["54"])
            except ValueError:
                amount = None
        result["method"] = "emv-qr"
        if crc_ok is False:
            result["method"] = "qr-text"
    else:
        result["method"] = "qr-text"

    expected = float(expected_amount or 0)
    if amount is None:
        candidates = find_amounts(text)
        for value in candidates:
            if abs(value - expected) < 0.009:
                amount = value
                break
        if amount is None and expected > 0:
            expected_int = str(int(round(expected)))
            expected_money = f"{expected:.2f}"
            if expected_money in text or re.search(rf"(?<!\d){re.escape(expected_int)}(?!\d)", text):
                amount = expected
        if amount is None:
            money = re.findall(r"(?<!\d)(\d+\.\d{2})(?!\d)", text)
            if money:
                try:
                    amount = float(money[0])
                except ValueError:
                    amount = None

    result["amount"] = amount
    amount_ok = amount is not None and abs(amount - expected) < 0.009
    amount_wrong = amount is not None and not amount_ok
    account_ok = account_matches(digits, payment or {}, text)

    if amount_wrong:
        result["reason"] = f"ยอดบนสลิปไม่ตรงกับยอดจอง ({expected:.2f} บาท) กรุณาแนบสลิปใหม่"
        return result

    # พบคิวอาร์บนสลิปแล้ว — รับเข้าระบบเป็นรอตรวจ ไม่ยืนยันอัตโนมัติ
    result["ok"] = True
    result["autoConfirm"] = False
    if amount_ok and account_ok:
        result["reason"] = "พบสลิป · คิวอาร์ตรงยอดและบัญชี รอผู้จัดงานยืนยัน"
    elif amount_ok:
        result["reason"] = "พบสลิป · คิวอาร์ตรงยอด รอผู้จัดงานยืนยัน"
    elif account_ok:
        result["reason"] = "พบสลิป · คิวอาร์ตรงบัญชี รอผู้จัดงานยืนยัน"
    else:
        result["reason"] = "พบสลิปแล้ว รอผู้จัดงานตรวจสอบ"
    return result


def apply_slip_check(row, body, cat):
    payment = cat.get("payment") or {}
    check = verify_slip_qr(body.get("slipQr"), row.get("total"), payment)
    row["slipCheck"] = check
    return check


def require_valid_slip(body, total, cat):
    """ตรวจสลิปก่อนบันทึก — ต้องเป็นรูปสลิปที่มีคิวอาร์ คืน (check, error_message)"""
    if not body.get("slipData"):
        return None, "กรุณาแนบรูปสลิปก่อนยืนยัน"
    if not valid_slip(body.get("slipData"), required=True):
        return None, "ไฟล์สลิปต้องเป็นรูปภาพขนาดไม่เกิน 1.5 MB"
    check = verify_slip_qr(body.get("slipQr"), total, cat.get("payment") or {})
    if not check.get("ok"):
        return check, check.get("reason") or "รูปที่แนบไม่ใช่สลิป กรุณาแนบสลิปใหม่"
    return check, None


def is_open(day):
    end = datetime.fromisoformat(day + "T23:59:59+07:00")
    return datetime.now(timezone.utc) <= end


def make_code(prefix, used):
    while True:
        code = prefix + "".join(secrets.choice(ALPHABET) for _ in range(4))
        if code not in used:
            return code


def to_public(row):
    data = {key: value for key, value in row.items() if key != "slipData"}
    data["hasSlip"] = bool(row.get("slipData"))
    return data


def bangkok_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Asia/Bangkok")).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")


def sheets_row_shirt(row):
    detail = ", ".join("%sx%s" % (item["size"], item["qty"]) for item in row.get("items") or [])
    payload = {
        "kind": "shirt",
        "code": row.get("code", ""),
        "status": STATUS_TH.get(row.get("status"), row.get("status", "")),
        "name": row.get("name", ""),
        "phone": row.get("phone", ""),
        "address": row.get("address", ""),
        "pickup": row.get("pickup", ""),
        "trackingNumber": row.get("trackingNumber", ""),
        "detail": detail,
        "total": row.get("total", 0),
        "hasSlip": bool(row.get("slipData") or row.get("slipUrl")),
        "slipUrl": row.get("slipUrl") or "",
        "slipStatus": (
            "รอตรวจสอบ"
            if row.get("status") == "pending"
            else (
                "ผ่านอัตโนมัติ" if (row.get("slipCheck") or {}).get("autoConfirm")
                else ((row.get("slipCheck") or {}).get("reason") or ("มีสลิป" if (row.get("slipData") or row.get("slipUrl")) else "ไม่มีสลิป"))
            )
        ),
        "createdAt": row.get("createdAt", ""),
        "updatedAt": bangkok_now(),
    }
    return payload


def sheets_row_table(row):
    payload = {
        "kind": "table",
        "code": row.get("code", ""),
        "status": STATUS_TH.get(row.get("status"), row.get("status", "")),
        "name": row.get("hostName", ""),
        "generation": row.get("generation", ""),
        "phone": row.get("phone", ""),
        "address": row.get("address", ""),
        "tableCount": row.get("tableCount", 0),
        "seats": row.get("seats", 0),
        "total": row.get("total", 0),
        "hasSlip": bool(row.get("slipData") or row.get("slipUrl")),
        "slipUrl": row.get("slipUrl") or "",
        "slipStatus": (
            "รอตรวจสอบ"
            if row.get("status") == "pending"
            else (
                "ผ่านอัตโนมัติ" if (row.get("slipCheck") or {}).get("autoConfirm")
                else ((row.get("slipCheck") or {}).get("reason") or ("มีสลิป" if (row.get("slipData") or row.get("slipUrl")) else "ไม่มีสลิป"))
            )
        ),
        "createdAt": row.get("createdAt", ""),
        "updatedAt": bangkok_now(),
    }
    return payload


def post_sheets(payload, timeout=60):
    if not SHEETS_WEBHOOK_URL:
        return False, "ยังไม่ได้ตั้ง SHEETS_WEBHOOK_URL", {}
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        SHEETS_WEBHOOK_URL,
        data=raw,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            if resp.status >= 400:
                return False, body[:200] or ("HTTP %s" % resp.status), {}
            try:
                parsed = json.loads(body) if body else {}
            except json.JSONDecodeError:
                parsed = {}
            return True, body[:200], parsed if isinstance(parsed, dict) else {}
    except urllib.error.HTTPError as err:
        return False, (err.read().decode("utf-8", errors="replace") or str(err))[:200], {}
    except Exception as err:
        return False, str(err)[:200], {}


def apply_sheet_response(kind, code, parsed):
    slip_url = clean((parsed or {}).get("slipUrl"), 500)
    if not slip_url or not code:
        return
    with LOCK:
        db = load_db()
        rows = db["shirts"] if kind == "shirt" else db["tables"]
        target = next((row for row in rows if row.get("code") == code), None)
        if target is None:
            return
        if target.get("slipUrl") != slip_url:
            target["slipUrl"] = slip_url
            save_db(db)


def notify_sheets(kind, row):
    if not SHEETS_WEBHOOK_URL:
        return

    def run():
        payload = sheets_row_shirt(row) if kind == "shirt" else sheets_row_table(row)
        if row.get("slipData") and not row.get("slipUrl"):
            payload["slipData"] = row.get("slipData")
            payload["slipName"] = row.get("slipName") or ""
        ok, detail, parsed = post_sheets(payload)
        if not ok:
            print("Google Sheets sync failed: %s" % detail, flush=True)
            return
        apply_sheet_response(kind, row.get("code"), parsed)

    threading.Thread(target=run, daemon=True).start()


def fetch_url_text(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": "niti-phayao-booking/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8-sig", errors="replace")


def fetch_sheet_csv(sheet_name):
    if not SHEETS_SPREADSHEET_ID:
        return ""
    import urllib.parse

    url = (
        "https://docs.google.com/spreadsheets/d/%s/gviz/tq?tqx=out:csv&sheet=%s"
        % (SHEETS_SPREADSHEET_ID, urllib.parse.quote(sheet_name))
    )
    return fetch_url_text(url)


def csv_rows(text):
    import csv
    import io

    if not text or not str(text).strip():
        return []
    return list(csv.DictReader(io.StringIO(text)))


def parse_status(value):
    raw = clean(value, 40)
    if raw in STATUS_TH:
        return raw
    return STATUS_FROM_TH.get(raw, "pending")


def parse_money(value):
    text = str(value or "").strip()
    if re.search(r"\d{4}-\d{2}-\d{2}T", text):
        return 0
    digits = re.sub(r"[^\d.]", "", text)
    if not digits:
        return 0
    try:
        amount = int(round(float(digits)))
    except ValueError:
        return 0
    if amount < 0 or amount > 500_000:
        return 0
    return amount


def looks_like_size_detail(value):
    return bool(parse_shirt_detail(value, 1, "x"))


def normalize_shirt_sheet_row(row):
    """Fix rows where Sheets headers were upgraded but old data columns were not shifted."""
    data = {str(key).strip().lstrip("\ufeff"): value for key, value in row.items()}
    if "วิธีรับ" not in data and "ลิงก์สลิป" not in data:
        return data
    detail = str(data.get("รายการ") or "")
    total_raw = str(data.get("ยอด") or "")
    address_slot = str(data.get("ที่อยู่") or "")
    pickup_slot = str(data.get("วิธีรับ") or "")
    misaligned = (
        looks_like_size_detail(address_slot)
        and not looks_like_size_detail(detail)
    ) or bool(re.search(r"\d{4}-\d{2}-\d{2}T", total_raw)) or parse_money(total_raw) > 100_000
    if not misaligned:
        return data
    return {
        **data,
        "วิธีรับ": "",
        "ที่อยู่": pickup_slot,
        "หมายเลขพัสดุ": "",
        "รายการ": address_slot,
        "ยอด": str(data.get("หมายเลขพัสดุ") or ""),
        "มีสลิป": detail,
        "ลิงก์สลิป": str(data.get("มีสลิป") or data.get("ลิงก์สลิป") or ""),
        "วันเวลาจอง": total_raw or str(data.get("วันเวลาจอง") or ""),
    }


def parse_shirt_detail(detail, unit_price, product_name):
    text = str(detail or "")
    merged = {}
    for size in SHIRT_SIZE_KEYS:
        pattern = re.compile(r"(?<![A-Za-z0-9])%s\s*[x×X]\s*(\d+)" % re.escape(size))
        for match in pattern.finditer(text):
            merged[size] = merged.get(size, 0) + int(match.group(1))
        text = pattern.sub(" ", text)
    return [
        {"size": size, "qty": qty, "price": unit_price, "name": product_name}
        for size, qty in merged.items()
        if qty > 0
    ]


def sheet_cell(row, *names):
    for name in names:
        if name in row and str(row.get(name) or "").strip() != "":
            return row.get(name)
    # tolerate BOM / whitespace in headers
    lowered = {str(key).strip().lstrip("\ufeff"): value for key, value in row.items()}
    for name in names:
        if name in lowered and str(lowered.get(name) or "").strip() != "":
            return lowered.get(name)
    return ""


def fetch_url_bytes(url, timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": "niti-phayao-booking/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(), (resp.headers.get("Content-Type") or "").split(";")[0].strip()


def drive_file_id(url):
    text = str(url or "")
    match = re.search(r"/d/([a-zA-Z0-9_-]{10,})", text)
    if match:
        return match.group(1)
    match = re.search(r"[?&]id=([a-zA-Z0-9_-]{10,})", text)
    if match:
        return match.group(1)
    return ""


def fetch_slip_as_data_url(url):
    target = clean(url, 500)
    if not target:
        return ""
    file_id = drive_file_id(target)
    candidates = []
    if file_id:
        candidates.append("https://drive.google.com/uc?export=download&id=%s" % file_id)
    candidates.append(target)
    import base64

    for candidate in candidates:
        try:
            raw, mime = fetch_url_bytes(candidate)
            if not raw or len(raw) < 40:
                continue
            if raw[:1] in (b"<", b"{") and b"html" in raw[:200].lower():
                continue
            if not mime.startswith("image/"):
                if raw[:3] == b"\xff\xd8\xff":
                    mime = "image/jpeg"
                elif raw[:8] == b"\x89PNG\r\n\x1a\n":
                    mime = "image/png"
                elif raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
                    mime = "image/webp"
                else:
                    continue
            encoded = base64.b64encode(raw).decode("ascii")
            return "data:%s;base64,%s" % (mime, encoded)
        except Exception:
            continue
    return ""


def attach_slip_from_url(order):
    if order.get("slipData"):
        return order
    url = order.get("slipUrl") or ""
    if not url:
        return order
    data_url = fetch_slip_as_data_url(url)
    if data_url:
        order["slipData"] = data_url
        if not order.get("slipName"):
            order["slipName"] = "%s-slip.jpg" % order.get("code", "slip")
        order["note"] = clean(str(order.get("note") or "").replace("ไฟล์สลิปไม่ถูกเก็บในชีท", "ดึงสลิปจาก Drive แล้ว"), 500)
        check = order.get("slipCheck") if isinstance(order.get("slipCheck"), dict) else {}
        check.update({"ok": True, "reason": "ดึงสลิปจาก Google Drive"})
        order["slipCheck"] = check
    return order


def shirt_from_sheet(row, cat):
    row = normalize_shirt_sheet_row(row)
    code = clean(sheet_cell(row, "รหัส", "code"), 20).upper()
    if not code.startswith("SH"):
        return None
    name = clean(sheet_cell(row, "ชื่อ", "name"), 80)
    phone = phone_of(sheet_cell(row, "เบอร์โทร", "phone"))
    address = clean(sheet_cell(row, "ที่อยู่", "address"), 300)
    pickup = clean(sheet_cell(row, "วิธีรับ", "pickup"), 20)
    if pickup not in ("รับเอง", "จัดส่ง"):
        pickup = "จัดส่ง" if len(address) >= 8 else "รับเอง"
    if pickup == "รับเอง":
        address = address if len(address) >= 8 else ""
    detail = sheet_cell(row, "รายการ", "detail")
    unit = int(cat["shirt"]["price"])
    items = parse_shirt_detail(detail, unit, cat["shirt"]["name"])
    if not items:
        items = [{"size": "M", "qty": 1, "price": unit, "name": cat["shirt"]["name"]}]
    item_total = sum(item["price"] * item["qty"] for item in items)
    total = parse_money(sheet_cell(row, "ยอด", "total")) or item_total
    shipping_fee = max(0, total - item_total) if pickup == "จัดส่ง" else 0
    # If delivery but sheet total has no shipping yet, keep sheet total as paid amount
    created = clean(sheet_cell(row, "วันเวลาจอง", "createdAt"), 60) or datetime.now(timezone.utc).isoformat()
    slip_url = clean(sheet_cell(row, "ลิงก์สลิป", "slipUrl"), 500)
    slip_mark = clean(sheet_cell(row, "มีสลิป", "slipStatus", "hasSlip"), 40)
    has_slip_mark = bool(slip_url) or slip_mark not in ("", "ไม่", "ไม่มี", "false", "False", "0")
    order = {
        "id": str(uuid.uuid5(uuid.NAMESPACE_URL, "shirt:%s" % code)),
        "code": code,
        "createdAt": created,
        "name": name or code,
        "nickname": "",
        "generation": "",
        "phone": phone if valid_phone(phone) else phone_of("0" + phone) if phone else "",
        "lineId": "",
        "pickup": pickup,
        "address": address if pickup == "จัดส่ง" else "",
        "trackingNumber": clean(sheet_cell(row, "หมายเลขพัสดุ", "trackingNumber"), 80),
        "items": items,
        "shippingFee": shipping_fee,
        "total": total,
        "note": "นำเข้าจาก Google Sheets" + (" · มีลิงก์สลิป" if slip_url else (" · ชีทระบุว่ามีสลิป (ยังไม่มีลิงก์รูป)" if has_slip_mark else "")),
        "slipName": "",
        "slipData": "",
        "slipUrl": slip_url,
        "status": parse_status(sheet_cell(row, "สถานะ", "status")),
        "slipCheck": {"ok": has_slip_mark, "autoConfirm": False, "reason": "นำเข้าจาก Sheets"},
    }
    return attach_slip_from_url(order)


def table_from_sheet(row, cat):
    code = clean(sheet_cell(row, "รหัส", "code"), 20).upper()
    if not code.startswith("TB"):
        return None
    seats_per = int(cat["table"]["seats"])
    count = positive_int(sheet_cell(row, "จำนวนโต๊ะ", "tableCount"), 50) or 1
    seats = positive_int(sheet_cell(row, "จำนวนท่าน", "seats"), 500) or count * seats_per
    total = parse_money(sheet_cell(row, "ยอด", "total")) or count * int(cat["table"]["price"])
    phone = phone_of(sheet_cell(row, "เบอร์โทร", "phone"))
    created = clean(sheet_cell(row, "วันเวลาจอง", "createdAt"), 60) or datetime.now(timezone.utc).isoformat()
    slip_url = clean(sheet_cell(row, "ลิงก์สลิป", "slipUrl"), 500)
    slip_mark = clean(sheet_cell(row, "มีสลิป", "slipStatus", "hasSlip"), 40)
    has_slip_mark = bool(slip_url) or slip_mark not in ("", "ไม่", "ไม่มี", "false", "False", "0")
    order = {
        "id": str(uuid.uuid5(uuid.NAMESPACE_URL, "table:%s" % code)),
        "code": code,
        "createdAt": created,
        "hostName": clean(sheet_cell(row, "ชื่อ", "name", "hostName"), 80) or code,
        "generation": clean(sheet_cell(row, "รุ่น", "generation"), 40),
        "phone": phone if valid_phone(phone) else phone,
        "address": clean(sheet_cell(row, "ที่อยู่", "address"), 300),
        "tableCount": count,
        "seats": seats,
        "total": total,
        "note": "นำเข้าจาก Google Sheets" + (" · มีลิงก์สลิป" if slip_url else ""),
        "slipName": "",
        "slipData": "",
        "slipUrl": slip_url,
        "status": parse_status(sheet_cell(row, "สถานะ", "status")),
        "slipCheck": {"ok": has_slip_mark, "autoConfirm": False, "reason": "นำเข้าจาก Sheets"},
    }
    return attach_slip_from_url(order)


def merge_booking(existing, incoming):
    """Fill gaps from Sheets without wiping slip images or newer local edits."""
    if not existing:
        return incoming, "added"
    changed = False
    try:
        existing_total = int(existing.get("total") or 0)
    except (TypeError, ValueError):
        existing_total = 0
    incoming_total = 0
    try:
        incoming_total = int(incoming.get("total") or 0)
    except (TypeError, ValueError):
        incoming_total = 0
    # Always trust freshly parsed sheet money/items when they look valid.
    # This repairs rows corrupted by misaligned sheet headers.
    sheet_money_keys = ("items", "total", "shippingFee", "pickup", "address", "trackingNumber", "name", "hostName", "phone")
    trust_sheet = 0 < incoming_total <= 100_000
    for key in (
        "name", "hostName", "phone", "address", "pickup", "trackingNumber",
        "generation", "items", "tableCount", "seats", "total", "shippingFee", "status", "createdAt", "slipUrl",
    ):
        if key not in incoming:
            continue
        new_val = incoming.get(key)
        old_val = existing.get(key)
        if trust_sheet and key in sheet_money_keys and new_val not in ("", None, []):
            if new_val != old_val:
                existing[key] = new_val
                changed = True
            continue
        if new_val in ("", None, [], 0) and old_val not in ("", None, [], 0):
            continue
        if key == "status" and old_val == "confirmed" and new_val == "pending":
            continue
        if new_val != old_val and new_val not in ("", None, []):
            existing[key] = new_val
            changed = True
    if not existing.get("slipData") and incoming.get("slipData"):
        existing["slipData"] = incoming["slipData"]
        existing["slipName"] = incoming.get("slipName") or existing.get("slipName") or ""
        changed = True
    if not existing.get("slipData") and existing.get("slipUrl"):
        attach_slip_from_url(existing)
        if existing.get("slipData"):
            changed = True
    if not existing.get("slipData") and incoming.get("note"):
        if existing.get("note") != incoming.get("note"):
            existing["note"] = incoming.get("note")
            changed = True
    return existing, ("updated" if changed else "kept")


def load_rows_from_sheets_csv():
    cat = load_catalog()
    shirts = []
    tables = []
    try:
        for row in csv_rows(fetch_sheet_csv("จองเสื้อ")):
            parsed = shirt_from_sheet(row, cat)
            if parsed:
                shirts.append(parsed)
    except Exception as err:
        print("Sheets shirt CSV failed: %s" % err, flush=True)
    try:
        for row in csv_rows(fetch_sheet_csv("จองโต๊ะ")):
            parsed = table_from_sheet(row, cat)
            if parsed:
                tables.append(parsed)
    except Exception as err:
        print("Sheets table CSV failed: %s" % err, flush=True)
    return shirts, tables


def load_rows_from_sheets_webhook():
    if not SHEETS_WEBHOOK_URL:
        return [], []
    url = SHEETS_WEBHOOK_URL
    sep = "&" if "?" in url else "?"
    try:
        raw = fetch_url_text(url + sep + "action=export")
        data = json.loads(raw)
        if not data.get("ok"):
            return [], []
        cat = load_catalog()
        shirts = []
        tables = []
        for row in data.get("shirts") or []:
            if isinstance(row, dict) and row.get("code"):
                # webhook export uses same sheet field names as upsert payload inverted — accept either
                parsed = shirt_from_sheet(row, cat) if "รหัส" in row or "รายการ" in row else None
                if parsed is None and row.get("items"):
                    shirts.append(row)
                elif parsed:
                    shirts.append(parsed)
                else:
                    mapped = {
                        "รหัส": row.get("code"),
                        "สถานะ": STATUS_TH.get(row.get("status"), row.get("status")),
                        "ชื่อ": row.get("name"),
                        "เบอร์โทร": row.get("phone"),
                        "วิธีรับ": row.get("pickup"),
                        "ที่อยู่": row.get("address"),
                        "หมายเลขพัสดุ": row.get("trackingNumber"),
                        "รายการ": row.get("detail"),
                        "ยอด": row.get("total"),
                        "มีสลิป": row.get("slipStatus") or row.get("hasSlip"),
                        "ลิงก์สลิป": row.get("slipUrl") or row.get("ลิงก์สลิป"),
                        "วันเวลาจอง": row.get("createdAt"),
                    }
                    parsed = shirt_from_sheet(mapped, cat)
                    if parsed:
                        shirts.append(parsed)
        for row in data.get("tables") or []:
            if isinstance(row, dict) and row.get("code"):
                mapped = {
                    "รหัส": row.get("code"),
                    "สถานะ": STATUS_TH.get(row.get("status"), row.get("status")),
                    "ชื่อ": row.get("name") or row.get("hostName"),
                    "รุ่น": row.get("generation"),
                    "เบอร์โทร": row.get("phone"),
                    "ที่อยู่": row.get("address"),
                    "จำนวนโต๊ะ": row.get("tableCount"),
                    "จำนวนท่าน": row.get("seats"),
                    "ยอด": row.get("total"),
                    "มีสลิป": row.get("slipStatus") or row.get("hasSlip"),
                    "ลิงก์สลิป": row.get("slipUrl") or row.get("ลิงก์สลิป"),
                    "วันเวลาจอง": row.get("createdAt"),
                }
                parsed = table_from_sheet(mapped, cat)
                if parsed:
                    tables.append(parsed)
        return shirts, tables
    except Exception as err:
        print("Sheets webhook export failed: %s" % err, flush=True)
        return [], []


def hydrate_from_sheets():
    """Merge Google Sheets bookings into local db so Render redeploys can recover."""
    shirts, tables = load_rows_from_sheets_webhook()
    if not shirts and not tables:
        shirts, tables = load_rows_from_sheets_csv()
    if not shirts and not tables:
        return {"ok": False, "added": 0, "updated": 0, "kept": 0, "error": "ไม่พบข้อมูลใน Google Sheets"}
    added = updated = kept = 0
    with LOCK:
        db = load_db()
        by_shirt = {row.get("code"): row for row in db.get("shirts") or []}
        by_table = {row.get("code"): row for row in db.get("tables") or []}
        for row in shirts:
            code = row.get("code")
            merged, action = merge_booking(by_shirt.get(code), row)
            if action == "added":
                db.setdefault("shirts", []).append(merged)
                by_shirt[code] = merged
                added += 1
            elif action == "updated":
                updated += 1
            else:
                kept += 1
        for row in tables:
            code = row.get("code")
            merged, action = merge_booking(by_table.get(code), row)
            if action == "added":
                db.setdefault("tables", []).append(merged)
                by_table[code] = merged
                added += 1
            elif action == "updated":
                updated += 1
            else:
                kept += 1
        save_db(db)
    return {"ok": True, "added": added, "updated": updated, "kept": kept, "shirts": len(shirts), "tables": len(tables)}


def public_view(db, cat):
    shirts = [row for row in db["shirts"] if row["status"] != "cancelled"]
    tables = [row for row in db["tables"] if row["status"] != "cancelled"]
    return {
        "event": cat["event"],
        "shirt": cat["shirt"],
        "table": cat["table"],
        "payment": cat["payment"],
        "generations": cat["generations"],
        "shirtOpen": is_open(cat["shirt"]["deadline"]),
        "tableOpen": is_open(cat["table"]["deadline"]),
        "counts": {
            "shirtOrders": len(shirts),
            "shirtPieces": sum(item["qty"] for row in shirts for item in row["items"]),
            "tablesBooked": sum(row["tableCount"] for row in tables),
        },
    }


def positive_int(value, upper):
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 1 or value > upper:
        return None
    return value


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 3_000_000:
            raise ValueError("too-large")
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def require_admin(self):
        return hmac.compare_digest(self.headers.get("X-Admin-Token", ""), TOKEN)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/health":
                self.send_json(200, {"ok": True})
                return
            if path == "/api/public":
                self.send_json(200, public_view(load_db(), load_catalog()))
                return
            if path == "/api/admin/bookings":
                if not self.require_admin():
                    self.send_json(401, {"error": "รหัสผู้ดูแลไม่ถูกต้อง"})
                    return
                self.send_json(200, load_db())
                return
            if path in FILES:
                name, mime = FILES[path]
                body = (ROOT / name).read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_json(404, {"error": "ไม่พบหน้านี้"})
        except Exception:
            traceback.print_exc()
            self.send_json(500, {"error": "ระบบขัดข้อง"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            try:
                body = self.read_json()
            except ValueError:
                self.send_json(413, {"error": "ไฟล์สลิปมีขนาดใหญ่เกินไป"})
                return
            except json.JSONDecodeError:
                self.send_json(400, {"error": "ข้อมูลที่ส่งไม่ถูกต้อง"})
                return
            if path == "/api/shirts":
                self.create_shirt(body)
                return
            if path == "/api/tables":
                self.create_table(body)
                return
            if path == "/api/lookup":
                self.lookup(body)
                return
            if path == "/api/slip":
                self.attach_slip(body)
                return
            if path == "/api/admin/login":
                self.admin_login(body)
                return
            if path == "/api/admin/status":
                self.admin_status(body)
                return
            if path == "/api/admin/tracking":
                self.admin_tracking(body)
                return
            if path == "/api/admin/sheets-sync":
                self.admin_sheets_sync()
                return
            if path == "/api/admin/sheets-restore":
                self.admin_sheets_restore()
                return
            self.send_json(404, {"error": "ไม่พบรายการ"})
        except Exception:
            traceback.print_exc()
            self.send_json(500, {"error": "บันทึกไม่สำเร็จ"})

    def create_shirt(self, body):
        cat = load_catalog()
        if not is_open(cat["shirt"]["deadline"]):
            self.send_json(400, {"error": "ปิดรับจองเสื้อแล้วเมื่อ " + cat["shirt"]["deadlineLabel"]})
            return
        name = clean(body.get("name"), 80)
        phone = phone_of(body.get("phone"))
        generation = clean(body.get("generation"), 40)
        items = body.get("items") if isinstance(body.get("items"), list) else []
        if len(name) < 2:
            self.send_json(400, {"error": "กรุณากรอกชื่อ-นามสกุล"})
            return
        if not valid_phone(phone):
            self.send_json(400, {"error": "กรุณากรอกเบอร์โทรให้ถูกต้อง"})
            return
        if not items or len(items) > 12:
            self.send_json(400, {"error": "กรุณาเลือกขนาดเสื้อ"})
            return
        if not body.get("slipData"):
            self.send_json(400, {"error": "กรุณาแนบรูปสลิปก่อนยืนยันการโอน"})
            return
        if not valid_slip(body.get("slipData"), required=True):
            self.send_json(400, {"error": "ไฟล์สลิปต้องเป็นรูปภาพขนาดไม่เกิน 1.5 MB"})
            return
        pickup = clean(body.get("pickup"), 20)
        if pickup not in ("รับเอง", "จัดส่ง"):
            self.send_json(400, {"error": "กรุณาเลือกวิธีรับเสื้อ รับเอง หรือจัดส่ง"})
            return
        if pickup == "จัดส่ง":
            address = clean(body.get("address"), 300)
            if len(address) < 8:
                self.send_json(400, {"error": "กรุณากรอกที่อยู่จัดส่ง"})
                return
        else:
            address = ""
        merged = {}
        for item in items:
            if not isinstance(item, dict):
                self.send_json(400, {"error": "รายการเสื้อไม่ถูกต้อง"})
                return
            size = str(item.get("size") or "")
            qty = positive_int(item.get("qty"), 20)
            if size not in cat["shirt"]["sizes"] or qty is None:
                self.send_json(400, {"error": "ขนาดหรือจำนวนเสื้อไม่ถูกต้อง"})
                return
            merged[size] = merged.get(size, 0) + qty
        if any(qty > 20 for qty in merged.values()):
            self.send_json(400, {"error": "สั่งได้ไม่เกิน 20 ตัวต่อขนาด"})
            return
        normalized = [
            {"size": size, "qty": qty, "price": cat["shirt"]["price"], "name": cat["shirt"]["name"]}
            for size, qty in merged.items()
        ]
        total = sum(item["price"] * item["qty"] for item in normalized)
        shipping_fee = int(cat["shirt"].get("shippingFee") or 0) if pickup == "จัดส่ง" else 0
        if shipping_fee < 0:
            shipping_fee = 0
        total += shipping_fee
        check, slip_error = require_valid_slip(body, total, cat)
        if slip_error:
            self.send_json(400, {"error": slip_error, "slipCheck": check})
            return
        with LOCK:
            db = load_db()
            used = {row["code"] for row in db["shirts"] + db["tables"]}
            order = {
                "id": str(uuid.uuid4()),
                "code": make_code("SH", used),
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "name": name,
                "nickname": clean(body.get("nickname"), 40),
                "generation": generation,
                "phone": phone,
                "lineId": clean(body.get("lineId"), 40),
                "pickup": pickup,
                "address": address,
                "trackingNumber": "",
                "items": normalized,
                "shippingFee": shipping_fee,
                "total": total,
                "note": clean(body.get("note"), 500),
                "slipName": clean(body.get("slipName"), 120),
                "slipData": body.get("slipData") or "",
                "status": "pending",
                "slipCheck": check,
            }
            db["shirts"].append(order)
            save_db(db)
        notify_sheets("shirt", order)
        self.send_json(201, {"order": to_public(order)})

    def create_table(self, body):
        cat = load_catalog()
        if not is_open(cat["table"]["deadline"]):
            self.send_json(400, {"error": "ปิดรับจองโต๊ะแล้วเมื่อ " + cat["table"]["deadlineLabel"]})
            return
        host = clean(body.get("hostName"), 80)
        phone = phone_of(body.get("phone"))
        generation = re.sub(r"\D", "", clean(body.get("generation"), 40))
        if len(generation) >= 2:
            generation = generation[:2]
        if not re.fullmatch(r"\d{2}", generation):
            self.send_json(400, {"error": "ระบุรุ่น 2 หลักแรกของรหัสนิสิต เช่น 51"})
            return
        count = positive_int(body.get("tableCount"), cat["table"]["maxPerOrder"])
        if len(host) < 2:
            self.send_json(400, {"error": "กรุณากรอกชื่อเจ้าภาพ"})
            return
        if not valid_phone(phone):
            self.send_json(400, {"error": "กรุณากรอกเบอร์โทรให้ถูกต้อง"})
            return
        address = clean(body.get("address"), 300)
        if len(address) < 8:
            self.send_json(400, {"error": "กรุณากรอกที่อยู่"})
            return
        if count is None:
            self.send_json(400, {"error": "จำนวนโต๊ะไม่ถูกต้อง"})
            return
        if not body.get("slipData"):
            self.send_json(400, {"error": "กรุณาแนบรูปสลิปก่อนยืนยันการชำระเงิน"})
            return
        if not valid_slip(body.get("slipData"), required=True):
            self.send_json(400, {"error": "ไฟล์สลิปต้องเป็นรูปภาพขนาดไม่เกิน 1.5 MB"})
            return
        total = count * cat["table"]["price"]
        check, slip_error = require_valid_slip(body, total, cat)
        if slip_error:
            self.send_json(400, {"error": slip_error, "slipCheck": check})
            return
        with LOCK:
            db = load_db()
            cap = cat["table"].get("maxTables")
            if isinstance(cap, int):
                booked = sum(row["tableCount"] for row in db["tables"] if row["status"] != "cancelled")
                if booked + count > cap:
                    self.send_json(409, {"error": "โต๊ะว่างไม่พอสำหรับการจองนี้"})
                    return
            used = {row["code"] for row in db["shirts"] + db["tables"]}
            booking = {
                "id": str(uuid.uuid4()),
                "code": make_code("TB", used),
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "hostName": host,
                "nickname": clean(body.get("nickname"), 40),
                "generation": generation,
                "phone": phone,
                "lineId": clean(body.get("lineId"), 40),
                "address": address,
                "tableCount": count,
                "seats": count * cat["table"]["seats"],
                "guests": clean(body.get("guests"), 800),
                "note": clean(body.get("note"), 500),
                "total": total,
                "slipName": clean(body.get("slipName"), 120),
                "slipData": body.get("slipData") or "",
                "status": "pending",
                "slipCheck": check,
            }
            db["tables"].append(booking)
            save_db(db)
        notify_sheets("table", booking)
        self.send_json(201, {"booking": to_public(booking)})

    def lookup(self, body):
        phone = phone_of(body.get("phone"))
        if not valid_phone(phone):
            self.send_json(400, {"error": "กรุณากรอกเบอร์โทรให้ถูกต้อง"})
            return
        db = load_db()
        shirts = [to_public(row) for row in reversed(db["shirts"]) if row["phone"] == phone]
        tables = [to_public(row) for row in reversed(db["tables"]) if row["phone"] == phone]
        self.send_json(200, {"shirts": shirts, "tables": tables})

    def attach_slip(self, body):
        phone = phone_of(body.get("phone"))
        code = clean(body.get("code"), 20).upper()
        if not valid_phone(phone) or not body.get("slipData") or not valid_slip(body.get("slipData")):
            self.send_json(400, {"error": "กรุณาอัปโหลดรูปสลิปให้ถูกต้อง"})
            return
        with LOCK:
            db = load_db()
            target = next((row for row in db["shirts"] + db["tables"] if row["code"] == code and row["phone"] == phone), None)
            if target is None:
                self.send_json(404, {"error": "ไม่พบรายการจองที่ตรงกับรหัสและเบอร์โทร"})
                return
            if target["status"] == "cancelled":
                self.send_json(400, {"error": "รายการนี้ถูกยกเลิกแล้ว"})
                return
            if target["status"] == "confirmed":
                self.send_json(400, {"error": "รายการยืนยันแล้ว ไม่สามารถเปลี่ยนสลิปได้ กรุณาติดต่อผู้จัดงาน"})
                return
            cat = load_catalog()
            check, slip_error = require_valid_slip(body, target.get("total"), cat)
            if slip_error:
                self.send_json(400, {"error": slip_error, "slipCheck": check})
                return
            target["slipData"] = body["slipData"]
            target["slipName"] = clean(body.get("slipName"), 120)
            target["slipCheck"] = check
            target["status"] = "pending"
            kind = "shirt" if str(target.get("code", "")).startswith("SH") else "table"
            save_db(db)
        notify_sheets(kind, target)
        self.send_json(200, {"ok": True, "slipCheck": target.get("slipCheck"), "status": target.get("status")})

    def admin_login(self, body):
        password = str(body.get("password") or "")
        if not hmac.compare_digest(password, ADMIN_PASSWORD):
            self.send_json(401, {"error": "รหัสผ่านไม่ถูกต้อง"})
            return
        self.send_json(200, {"token": TOKEN})

    def admin_status(self, body):
        if not self.require_admin():
            self.send_json(401, {"error": "รหัสผู้ดูแลไม่ถูกต้อง"})
            return
        kind = body.get("kind")
        status = body.get("status")
        if kind not in ("shirt", "table") or status not in ("pending", "confirmed", "cancelled"):
            self.send_json(400, {"error": "สถานะไม่ถูกต้อง"})
            return
        with LOCK:
            db = load_db()
            rows = db["shirts"] if kind == "shirt" else db["tables"]
            target = next((row for row in rows if row["id"] == body.get("id")), None)
            if target is None:
                self.send_json(404, {"error": "ไม่พบรายการ"})
                return
            target["status"] = status
            save_db(db)
        notify_sheets(kind, target)
        self.send_json(200, {"ok": True})

    def admin_tracking(self, body):
        if not self.require_admin():
            self.send_json(401, {"error": "รหัสผู้ดูแลไม่ถูกต้อง"})
            return
        tracking = clean(body.get("trackingNumber"), 80)
        with LOCK:
            db = load_db()
            target = next((row for row in db["shirts"] if row["id"] == body.get("id")), None)
            if target is None:
                self.send_json(404, {"error": "ไม่พบรายการเสื้อ"})
                return
            if (target.get("pickup") or "จัดส่ง") != "จัดส่ง":
                self.send_json(400, {"error": "รายการรับเองไม่ต้องใส่หมายเลขพัสดุ"})
                return
            target["trackingNumber"] = tracking
            save_db(db)
        notify_sheets("shirt", target)
        self.send_json(200, {"ok": True, "trackingNumber": tracking})

    def admin_sheets_sync(self):
        if not self.require_admin():
            self.send_json(401, {"error": "รหัสผู้ดูแลไม่ถูกต้อง"})
            return
        if not SHEETS_WEBHOOK_URL:
            self.send_json(400, {"error": "ยังไม่ได้ตั้งค่า SHEETS_WEBHOOK_URL บนเซิร์ฟเวอร์"})
            return
        db = load_db()
        synced = 0
        uploaded = 0
        errors = []
        for kind, rows in (("shirt", db.get("shirts") or []), ("table", db.get("tables") or [])):
            for row in rows:
                payload = sheets_row_shirt(row) if kind == "shirt" else sheets_row_table(row)
                if row.get("slipData") and not row.get("slipUrl"):
                    payload["slipData"] = row.get("slipData")
                    payload["slipName"] = row.get("slipName") or ""
                ok, detail, parsed = post_sheets(payload, timeout=90)
                if not ok:
                    errors.append("%s: %s" % (row.get("code"), detail))
                    continue
                synced += 1
                slip_url = clean((parsed or {}).get("slipUrl"), 500)
                if slip_url:
                    uploaded += 1
                    apply_sheet_response(kind, row.get("code"), parsed)
        if errors and not synced:
            self.send_json(502, {"error": "ส่งไป Google Sheets ไม่สำเร็จ", "detail": errors[0]})
            return
        self.send_json(200, {"ok": True, "count": synced, "slipUploaded": uploaded, "errors": errors[:5]})

    def admin_sheets_restore(self):
        if not self.require_admin():
            self.send_json(401, {"error": "รหัสผู้ดูแลไม่ถูกต้อง"})
            return
        result = hydrate_from_sheets()
        if not result.get("ok"):
            self.send_json(502, {"error": result.get("error") or "ดึงจาก Google Sheets ไม่สำเร็จ"})
            return
        self.send_json(200, result)


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not os.environ.get("ADMIN_PASSWORD"):
        print("คำเตือน: ใช้รหัสผู้จัดงานค่าเริ่มต้น ตั้ง ADMIN_PASSWORD ก่อนขึ้นเว็บจริง", flush=True)
    if SHEETS_WEBHOOK_URL:
        print("เชื่อม Google Sheets webhook แล้ว", flush=True)
    else:
        print("ยังไม่เชื่อม SHEETS_WEBHOOK_URL (ยังดึง CSV จากชีทได้ถ้ามี SHEETS_SPREADSHEET_ID)", flush=True)
    if SHEETS_SPREADSHEET_ID:
        print("Sheets spreadsheet: %s" % SHEETS_SPREADSHEET_ID, flush=True)
        try:
            result = hydrate_from_sheets()
            if result.get("ok"):
                print(
                    "กู้จาก Sheets: เพิ่ม %s · อัปเดต %s · คงเดิม %s (ชีทเสื้อ %s / โต๊ะ %s)"
                    % (
                        result.get("added", 0),
                        result.get("updated", 0),
                        result.get("kept", 0),
                        result.get("shirts", 0),
                        result.get("tables", 0),
                    ),
                    flush=True,
                )
            else:
                print("กู้จาก Sheets: %s" % result.get("error"), flush=True)
        except Exception:
            traceback.print_exc()
    server = ThreadingHTTPServer((host, port), Handler)
    print("เปิดเว็บได้ที่ http://127.0.0.1:%s" % port, flush=True)
    server.serve_forever()
