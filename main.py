import telebot
import sqlite3
import re
from datetime import datetime
from typing import Optional

import os
TOKEN = os.getenv ("7994178151:AAGN7SFH2fFDMCx5TDZHFgWJ3nB8TdWRMV8")
bot = telebot.TeleBot(TOKEN)

DB_PATH = "finance.db"

# --------------------------
# НАСТРОЙКИ ТЕМ (вставишь после /where)
# --------------------------
BALANCE_THREAD_ID = 45   # тема "Баланс"
FOOD_THREAD_ID = 33      # тема "Еда" (отдельный бюджет, не влияет на общий)
APART_THREAD_ID = 78     # тема "Квартира" (уменьшает общий)
TOPUP_THREAD_ID = 80     # тема "Пополнение" (увеличивает общий)

# Другие темы, где расходы уменьшают общий (например: Путешествия, Для нас)
GENERAL_EXPENSE_THREADS = 34, 43

# --------------------------
# DB
# --------------------------
conn = sqlite3.connect(DB_PATH, check_same_thread=False)
cur = conn.cursor()

cur.execute("""
CREATE TABLE IF NOT EXISTS state (
  chat_id INTEGER PRIMARY KEY,
  total_cents INTEGER NOT NULL DEFAULT 0,
  food_cents INTEGER NOT NULL DEFAULT 2000000,   -- 20000.00 по умолчанию
  balance_message_id INTEGER
)
""")

cur.execute("""
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  category TEXT NOT NULL,          -- food / apart / topup / total_other
  amount_cents INTEGER NOT NULL,   -- всегда положительное
  direction TEXT NOT NULL,         -- in / out
  note TEXT,
  created_at TEXT NOT NULL
)
""")
conn.commit()

# --------------------------
# UTIL
# --------------------------
AMOUNT_RE = re.compile(r"^\s*([+-]?\d[\d\s]*([.,]\d{1,2})?)\s*(.*)$")

def now_str() -> str:
    return datetime.now().strftime("%d.%m.%Y %H:%M")

def to_cents(amount_str: str) -> int:
    """
    "2453.13" -> 245313
    "2453,1"  -> 245310
    "2453"    -> 245300
    """
    s = amount_str.strip().replace(" ", "").replace(",", ".")
    if not re.match(r"^[+-]?\d+(\.\d{1,2})?$", s):
        raise ValueError("bad amount")
    sign = -1 if s.startswith("-") else 1
    if s[0] in "+-":
        s = s[1:]
    if "." in s:
        a, b = s.split(".", 1)
        b = (b + "00")[:2]
    else:
        a, b = s, "00"
    return sign * (int(a) * 100 + int(b))

def money(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    v = abs(cents)
    rub = v // 100
    kop = v % 100
    rub_str = f"{rub:,}".replace(",", " ")
    return f"{sign}{rub_str}.{kop:02d}"

def ensure_state(chat_id: int):
    cur.execute("INSERT OR IGNORE INTO state(chat_id) VALUES(?)", (chat_id,))
    conn.commit()

def get_state(chat_id: int):
    ensure_state(chat_id)
    cur.execute("SELECT total_cents, food_cents, balance_message_id FROM state WHERE chat_id=?", (chat_id,))
    return cur.fetchone()  # total, food, balance_message_id

def set_total(chat_id: int, cents: int):
    ensure_state(chat_id)
    cur.execute("UPDATE state SET total_cents=? WHERE chat_id=?", (cents, chat_id))
    conn.commit()

def set_food(chat_id: int, cents: int):
    ensure_state(chat_id)
    cur.execute("UPDATE state SET food_cents=? WHERE chat_id=?", (cents, chat_id))
    conn.commit()

def set_balance_message_id(chat_id: int, msg_id: int):
    ensure_state(chat_id)
    cur.execute("UPDATE state SET balance_message_id=? WHERE chat_id=?", (msg_id, chat_id))
    conn.commit()

def add_entry(chat_id: int, thread_id: int, category: str, amount_cents: int, direction: str, note: str):
    cur.execute("""
      INSERT INTO entries(chat_id, thread_id, category, amount_cents, direction, note, created_at)
      VALUES(?,?,?,?,?,?,?)
    """, (chat_id, thread_id, category, amount_cents, direction, note, now_str()))
    conn.commit()

def parse_message(text: str):
    """
    Возвращает (amount_abs_cents, note, sign)
    sign: +1 если ввели положительное, -1 если ввели отрицательное.
    Но мы будем трактовать по теме:
    - в расходных темах положительное = расход
    - в пополнении положительное = доход
    """
    m = AMOUNT_RE.match(text or "")
    if not m:
        return None
    amount_str = m.group(1).replace(" ", "")
    note = (m.group(3) or "").strip()
    cents = to_cents(amount_str)
    amount_abs = abs(cents)
    if amount_abs == 0:
        return None
    sign = -1 if cents < 0 else 1
    return amount_abs, note, sign

def build_balance_text(total_cents: int, food_cents: int, last_line: Optional[str] = None) -> str:
    base = (
        f"📌 <b>Баланс</b>\n"
        f"💰 <b>Общий:</b> {money(total_cents)}\n"
        f"🍽 <b>Еда:</b> {money(food_cents)} \n"
        f"🕒 {now_str()}"
    )
    if last_line:
        base += f"\n\n{last_line}"
    return base

def update_balance_message(chat_id: int, text: str):
    total, food, msg_id = get_state(chat_id)
    if msg_id:
        try:
            bot.edit_message_text(
                text,
                chat_id,
                msg_id,
                message_thread_id=BALANCE_THREAD_ID,
                parse_mode="HTML"
            )
            return
        except Exception:
            pass

    sent = bot.send_message(chat_id, text, message_thread_id=BALANCE_THREAD_ID, parse_mode="HTML")
    set_balance_message_id(chat_id, sent.message_id)

# --------------------------
# COMMANDS
# --------------------------
@bot.message_handler(commands=["where"])
def where(message):
    bot.reply_to(message, f"chat_id={message.chat.id}\nthread_id={message.message_thread_id}")

@bot.message_handler(commands=["settotal"])
def settotal_cmd(message):
    if message.message_thread_id != BALANCE_THREAD_ID:
        bot.reply_to(message, "Команду /settotal пиши в теме 'Баланс'.")
        return
    parts = (message.text or "").split(maxsplit=1)
    if len(parts) < 2:
        bot.reply_to(message, "Формат: /settotal 10000.00")
        return
    try:
        cents = to_cents(parts[1])
    except ValueError:
        bot.reply_to(message, "Не понял сумму. Пример: /settotal 12345.67")
        return

    chat_id = message.chat.id
    set_total(chat_id, cents)
    total, food, _ = get_state(chat_id)
    update_balance_message(chat_id, build_balance_text(total, food, "✅ Установлен общий баланс."))
    bot.reply_to(message, "✅ Готово.")

@bot.message_handler(commands=["setfood"])
def setfood_cmd(message):
    if message.message_thread_id != BALANCE_THREAD_ID:
        bot.reply_to(message, "Команду /setfood пиши в теме 'Баланс'.")
        return
    parts = (message.text or "").split(maxsplit=1)
    if len(parts) < 2:
        bot.reply_to(message, "Формат: /setfood 20000.00")
        return
    try:
        cents = to_cents(parts[1])
    except ValueError:
        bot.reply_to(message, "Не понял сумму. Пример: /setfood 20000.00")
        return

    chat_id = message.chat.id
    set_food(chat_id, cents)
    total, food, _ = get_state(chat_id)
    update_balance_message(chat_id, build_balance_text(total, food, "✅ Установлен бюджет Еда."))
    bot.reply_to(message, "✅ Готово.")

@bot.message_handler(commands=["start"])
def start(message):
    bot.reply_to(
        message,
        "Я бот учёта по темам.\n\n"
        "Темы:\n"
        "🍽 Еда — отдельный бюджет, общий не трогает\n"
        "🏠 Квартира — расход, уменьшает общий\n"
        "➕ Пополнение — доход, увеличивает общий\n"
        "Другие отмеченные темы — расходы, уменьшают общий\n\n"
        "Команды (пиши в теме Баланс):\n"
        "/settotal 50000.00\n"
        "/setfood 20000.00\n\n"
        "Команда /where — показать thread_id темы"
    )

# --------------------------
# MAIN
# --------------------------
@bot.message_handler(func=lambda m: True, content_types=["text"])
def handle_message(message):
    if message.message_thread_id is None:
        return

    # Если темы ещё не настроены — молчим, чтобы не спамить
    if None in (BALANCE_THREAD_ID, FOOD_THREAD_ID, APART_THREAD_ID, TOPUP_THREAD_ID):
        return

    parsed = parse_message(message.text)
    if not parsed:
        return

    amount_abs, note, sign = parsed
    chat_id = message.chat.id
    thread_id = message.message_thread_id

    total, food, _ = get_state(chat_id)
    when = now_str()

    # --- ЛОГИКА ПО ТЕМАМ ---
    if thread_id == FOOD_THREAD_ID:
        # ЕДА: отдельный бюджет. Положительное — расход, отрицательное — пополнение еды.
        old_food = food
        if sign >= 0:  # расход
            new_food = old_food - amount_abs
            direction = "out"
            last = f"🍽 <b>Еда</b>: {money(old_food)} - {money(amount_abs)} = <b>{money(new_food)}</b>\n📝 {note}\n🕒 {when}"
        else:          # пополнение еды
            new_food = old_food + amount_abs
            direction = "in"
            last = f"🍽 <b>Еда</b>: {money(old_food)} + {money(amount_abs)} = <b>{money(new_food)}</b>\n📝 {note}\n🕒 {when}"

        set_food(chat_id, new_food)
        add_entry(chat_id, thread_id, "food", amount_abs, direction, note)

        # общий не меняем
        total, food, _ = get_state(chat_id)
        update_balance_message(chat_id, build_balance_text(total, food, last))
        bot.reply_to(message, "✅ Записал (Еда).")
        return

    if thread_id == TOPUP_THREAD_ID:
        # ПОПОЛНЕНИЕ: положительное — доход в общий, отрицательное — как расход из общего
        old_total = total
        if sign >= 0:  # доход
            new_total = old_total + amount_abs
            direction = "in"
            last = f"➕ <b>Пополнение</b>: {money(old_total)} + {money(amount_abs)} = <b>{money(new_total)}</b>\n📝 {note}\n🕒 {when}"
        else:          # если вдруг ввели отрицательное — считаем расходом общего
            new_total = old_total - amount_abs
            direction = "out"
            last = f"➖ <b>Списание</b>: {money(old_total)} - {money(amount_abs)} = <b>{money(new_total)}</b>\n📝 {note}\n🕒 {when}"

        set_total(chat_id, new_total)
        add_entry(chat_id, thread_id, "topup", amount_abs, direction, note)

        total, food, _ = get_state(chat_id)
        update_balance_message(chat_id, build_balance_text(total, food, last))
        bot.reply_to(message, "✅ Записал (Пополнение).")
        return

    # КВАРТИРА и прочие расходы: уменьшают общий (положительное — расход, отрицательное — возврат)
    if thread_id == APART_THREAD_ID or thread_id in GENERAL_EXPENSE_THREADS:
        category = "apart" if thread_id == APART_THREAD_ID else "total_other"
        label = "🏠 <b>Квартира</b>" if thread_id == APART_THREAD_ID else "💰 <b>Расход</b>"

        old_total = total
        if sign >= 0:  # расход
            new_total = old_total - amount_abs
            direction = "out"
            last = f"{label}: {money(old_total)} - {money(amount_abs)} = <b>{money(new_total)}</b>\n📝 {note}\n🕒 {when}"
        else:          # возврат/пополнение общего
            new_total = old_total + amount_abs
            direction = "in"
            last = f"{label}: {money(old_total)} + {money(amount_abs)} = <b>{money(new_total)}</b>\n📝 {note}\n🕒 {when}"

        set_total(chat_id, new_total)
        add_entry(chat_id, thread_id, category, amount_abs, direction, note)

        total, food, _ = get_state(chat_id)
        update_balance_message(chat_id, build_balance_text(total, food, last))
        bot.reply_to(message, "✅ Записал.")
        return

    # Неизвестная тема — игнор
    return


print("Бот запущен...")
bot.infinity_polling()

