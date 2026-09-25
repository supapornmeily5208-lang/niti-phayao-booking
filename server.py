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
TOKEN = hmac.new(b"niti-phayao-reunion", ADMIN_PASSWORD.encode(), hashlib.sha256).hexdigest()
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
LOCK = __import__("threading").Lock()
STATUS_TH = {"pending": "รอตรวจสอบ", "confirmed": "ยืนยันแล้ว", "cancelled": "ยกเลิก"}

FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/js/app.js": ("js/app.js", "text/javascript; charset=utf-8"),
    "/js/payload.js": ("js/payload.js", "text/javascript; charset=utf-8"),
    "/vendor/qrcode.js": ("vendor/qrcode.js", "text/javascript; charset=utf-8"),
    "/favicon.svg": ("public/favicon.svg", "image/svg+xml"),
    "/logo.jpg": ("public/logo.jpg", "image/jpeg"),
    "/shirt-sample.jpg": ("public/shirt-sample.jpg", "image/jpeg"),
    "/size-chart.jpg": ("public/size-chart.jpg", "image/jpeg"),
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
    return digits


def valid_phone(value):
    return re.fullmatch(r"0\d{8,9}", value) is not None


def valid_slip(data, required=False):
    if not data:
        return not required
    if not isinstance(data, str) or len(data) > 2_400_000:
        return False
    return re.fullmatch(r"data:image/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+", data) is not None


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
    return datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")


def sheets_row_shirt(row):
    detail = ", ".join("%sx%s" % (item["size"], item["qty"]) for item in row.get("items") or [])
    return {
        "kind": "shirt",
        "code": row.get("code", ""),
        "status": STATUS_TH.get(row.get("status"), row.get("status", "")),
        "name": row.get("name", ""),
        "phone": row.get("phone", ""),
        "address": row.get("address", ""),
        "detail": detail,
        "total": row.get("total", 0),
        "hasSlip": bool(row.get("slipData")),
        "createdAt": row.get("createdAt", ""),
        "updatedAt": bangkok_now(),
    }


def sheets_row_table(row):
    return {
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
        "hasSlip": bool(row.get("slipData")),
        "createdAt": row.get("createdAt", ""),
        "updatedAt": bangkok_now(),
    }


def post_sheets(payload):
    if not SHEETS_WEBHOOK_URL:
        return False, "ยังไม่ได้ตั้ง SHEETS_WEBHOOK_URL"
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        SHEETS_WEBHOOK_URL,
        data=raw,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            if resp.status >= 400:
                return False, body[:200] or ("HTTP %s" % resp.status)
            return True, body[:200]
    except urllib.error.HTTPError as err:
        return False, (err.read().decode("utf-8", errors="replace") or str(err))[:200]
    except Exception as err:
        return False, str(err)[:200]


def notify_sheets(kind, row):
    if not SHEETS_WEBHOOK_URL:
        return

    def run():
        payload = sheets_row_shirt(row) if kind == "shirt" else sheets_row_table(row)
        ok, detail = post_sheets(payload)
        if not ok:
            print("Google Sheets sync failed: %s" % detail, flush=True)

    threading.Thread(target=run, daemon=True).start()


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
            if path == "/api/admin/sheets-sync":
                self.admin_sheets_sync()
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
        if not valid_slip(body.get("slipData")):
            self.send_json(400, {"error": "ไฟล์สลิปต้องเป็นรูปภาพขนาดไม่เกิน 1.5 MB"})
            return
        address = clean(body.get("address"), 300)
        if len(address) < 8:
            self.send_json(400, {"error": "กรุณากรอกที่อยู่"})
            return
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
                "pickup": "จัดส่ง",
                "address": address,
                "items": normalized,
                "total": sum(item["price"] * item["qty"] for item in normalized),
                "note": clean(body.get("note"), 500),
                "slipName": clean(body.get("slipName"), 120) if body.get("slipData") else "",
                "slipData": body.get("slipData") or "",
                "status": "pending",
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
                "total": count * cat["table"]["price"],
                "slipName": clean(body.get("slipName"), 120) if body.get("slipData") else "",
                "slipData": body.get("slipData") or "",
                "status": "pending",
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
            target["slipData"] = body["slipData"]
            target["slipName"] = clean(body.get("slipName"), 120)
            kind = "shirt" if str(target.get("code", "")).startswith("SH") else "table"
            save_db(db)
        notify_sheets(kind, target)
        self.send_json(200, {"ok": True})

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

    def admin_sheets_sync(self):
        if not self.require_admin():
            self.send_json(401, {"error": "รหัสผู้ดูแลไม่ถูกต้อง"})
            return
        if not SHEETS_WEBHOOK_URL:
            self.send_json(400, {"error": "ยังไม่ได้ตั้งค่า SHEETS_WEBHOOK_URL บนเซิร์ฟเวอร์"})
            return
        db = load_db()
        rows = [sheets_row_shirt(row) for row in db["shirts"]] + [sheets_row_table(row) for row in db["tables"]]
        ok, detail = post_sheets({"action": "sync", "rows": rows})
        if not ok:
            self.send_json(502, {"error": "ส่งไป Google Sheets ไม่สำเร็จ", "detail": detail})
            return
        self.send_json(200, {"ok": True, "count": len(rows)})


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not os.environ.get("ADMIN_PASSWORD"):
        print("คำเตือน: ใช้รหัสผู้จัดงานค่าเริ่มต้น ตั้ง ADMIN_PASSWORD ก่อนขึ้นเว็บจริง", flush=True)
    if SHEETS_WEBHOOK_URL:
        print("เชื่อม Google Sheets แล้ว", flush=True)
    else:
        print("ยังไม่เชื่อม Google Sheets (ตั้ง SHEETS_WEBHOOK_URL เมื่อพร้อม)", flush=True)
    server = ThreadingHTTPServer((host, port), Handler)
    print("เปิดเว็บได้ที่ http://127.0.0.1:%s" % port, flush=True)
    server.serve_forever()
