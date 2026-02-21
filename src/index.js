export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    const update = await request.json().catch(() => null);
    const msg = update?.message;
    if (!msg?.chat?.id) return new Response("OK", { status: 200 });

    // --------------------------
    // НАСТРОЙКИ ТЕМ (вставь свои)
    // --------------------------
    const BALANCE_THREAD_ID = 45; // тема "Баланс"
    const FOOD_THREAD_ID = 33;    // тема "Еда"
    const APART_THREAD_ID = 78;   // тема "Квартира"
    const TOPUP_THREAD_ID = 80;   // тема "Пополнение"
    const FOOD_TOPUP_THREAD_ID = 247; // тема "Пополнение еды" (влияет только на еду)
    const GENERAL_EXPENSE_THREADS = new Set([34, 43]); // Путешествия, Для нас и т.п.

    // --------------------------
    // HELPERS
    // --------------------------
    const chatId = msg.chat.id;
    const threadId = msg.message_thread_id ?? null;
    const text = (msg.text ?? "").trim();

    const nowStr = () => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };

    const money = (cents) => {
      const sign = cents < 0 ? "-" : "";
      const v = Math.abs(cents);
      const rub = Math.floor(v / 100);
      const kop = v % 100;
      const rubStr = String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
      return `${sign}${rubStr}.${String(kop).padStart(2, "0")}`;
    };

    const toCentsSigned = (amountStr) => {
      const s0 = String(amountStr).trim().replace(/\s+/g, "").replace(",", ".");
      if (!/^[+-]?\d+(\.\d{1,2})?$/.test(s0)) throw new Error("bad amount");
      const sign = s0.startsWith("-") ? -1 : 1;
      const s = s0.replace(/^[+-]/, "");
      const [a, bRaw] = s.split(".");
      const b = ((bRaw ?? "") + "00").slice(0, 2);
      return sign * (parseInt(a, 10) * 100 + parseInt(b, 10));
    };

    const parseMessage = (t) => {
      const m = String(t || "").match(/^\s*([+-]?\d[\d\s]*([.,]\d{1,2})?)\s*(.*)$/);
      if (!m) return null;
      const amountStr = (m[1] || "").replace(/\s+/g, "");
      const note = String(m[3] || "").trim();
      const centsSigned = toCentsSigned(amountStr);
      const abs = Math.abs(centsSigned);
      if (!abs) return null;
      const sign = centsSigned < 0 ? -1 : 1;
      return { amount_abs: abs, note, sign };
    };

    const tg = async (method, body) => {
      if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN missing");
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(`${method} failed: ${JSON.stringify(data)}`);
      return data.result;
    };

    // --------------------------
    // KV storage (state + entries)
    // --------------------------
    const kState = `state:${chatId}`; // JSON: { total_cents, food_cents }
    const kEntries = `entries:${chatId}`; // last N

    const getState = async () => {
      const raw = await env.KV.get(kState);
      if (!raw) {
        // ВАЖНО: еда по умолчанию = 0 (ты задаёшь сам)
        const init = { total_cents: 0, food_cents: 0 };
        await env.KV.put(kState, JSON.stringify(init));
        return init;
      }
      try {
        const st = JSON.parse(raw);
        return {
          total_cents: Number(st.total_cents ?? 0),
          food_cents: Number(st.food_cents ?? 0),
        };
      } catch {
        const init = { total_cents: 0, food_cents: 0 };
        await env.KV.put(kState, JSON.stringify(init));
        return init;
      }
    };

    const saveState = async (st) => env.KV.put(kState, JSON.stringify(st));

    const addEntry = async ({ thread_id, category, amount_cents, direction, note, created_at }) => {
      const raw = await env.KV.get(kEntries);
      let arr = [];
      try { arr = raw ? JSON.parse(raw) : []; } catch { arr = []; }
      arr.unshift({ thread_id, category, amount_cents, direction, note, created_at });
      if (arr.length > 100) arr = arr.slice(0, 100);
      await env.KV.put(kEntries, JSON.stringify(arr));
    };

    const buildBalanceText = (st, lastLine = null) => {
      let base =
        `📌 <b>Баланс</b>\n` +
        `💰 <b>Общий:</b> ${money(st.total_cents)}\n` +
        `🍽 <b>Еда:</b> ${money(st.food_cents)}\n` +
        `🕒 ${nowStr()}`;
      if (lastLine) base += `\n\n${lastLine}`;
      return base;
    };

    // ВАЖНО: теперь ВСЕГДА создаём новое сообщение в теме Баланс (НЕ edit)
    const postBalance = async (textHtml) => {
      await tg("sendMessage", {
        chat_id: chatId,
        message_thread_id: BALANCE_THREAD_ID,
        text: textHtml,
        parse_mode: "HTML",
      });
    };

    // --------------------------
    // COMMANDS
    // --------------------------
    if (text === "/where") {
      await tg("sendMessage", {
        chat_id: chatId,
        message_thread_id: threadId ?? undefined,
        text: `chat_id=${chatId}\nthread_id=${threadId}`,
      });
      return new Response("OK", { status: 200 });
    }

    if (text === "/start") {
      await tg("sendMessage", {
        chat_id: chatId,
        message_thread_id: threadId ?? undefined,
        text:
          "Я бот учёта по темам.\n\n" +
          "🍽 Еда — отдельный бюджет, общий не трогает\n" +
          "🏠 Квартира — расход, уменьшает общий\n" +
          "➕ Пополнение — доход, увеличивает общий\n\n" +
          "Команды (пиши в теме Баланс):\n" +
          "/settotal 50000.00\n" +
          "/setfood 20000.00\n\n" +
          "Команда /where — показать thread_id темы",
      });
      return new Response("OK", { status: 200 });
    }

    if (text.startsWith("/settotal")) {
      if (threadId !== BALANCE_THREAD_ID) {
        await tg("sendMessage", { chat_id: chatId, message_thread_id: threadId ?? undefined, text: "Команду /settotal пиши в теме 'Баланс'." });
        return new Response("OK", { status: 200 });
      }
      const parts = text.split(/\s+/, 2);
      if (parts.length < 2) {
        await tg("sendMessage", { chat_id: chatId, message_thread_id: BALANCE_THREAD_ID, text: "Формат: /settotal 10000.00" });
        return new Response("OK", { status: 200 });
      }
      let cents;
      try { cents = toCentsSigned(parts[1]); } catch {
        await tg("sendMessage", { chat_id: chatId, message_thread_id: BALANCE_THREAD_ID, text: "Не понял сумму. Пример: /settotal 12345.67" });
        return new Response("OK", { status: 200 });
      }
      const st = await getState();
      st.total_cents = cents;
      await saveState(st);

      // НЕ пишем "Готово." — просто публикуем новое сообщение баланса
      await postBalance(buildBalanceText(st, "✅ Установлен общий баланс."));
      return new Response("OK", { status: 200 });
    }

    if (text.startsWith("/setfood")) {
      if (threadId !== BALANCE_THREAD_ID) {
        await tg("sendMessage", { chat_id: chatId, message_thread_id: threadId ?? undefined, text: "Команду /setfood пиши в теме 'Баланс'." });
        return new Response("OK", { status: 200 });
      }
      const parts = text.split(/\s+/, 2);
      if (parts.length < 2) {
        await tg("sendMessage", { chat_id: chatId, message_thread_id: BALANCE_THREAD_ID, text: "Формат: /setfood 20000.00" });
        return new Response("OK", { status: 200 });
      }
      let cents;
      try { cents = toCentsSigned(parts[1]); } catch {
        await tg("sendMessage", { chat_id: chatId, message_thread_id: BALANCE_THREAD_ID, text: "Не понял сумму. Пример: /setfood 20000.00" });
        return new Response("OK", { status: 200 });
      }
      const st = await getState();
      st.food_cents = cents;
      await saveState(st);

      // НЕ пишем "Готово." — просто публикуем новое сообщение баланса
      await postBalance(buildBalanceText(st, "✅ Установлен бюджет Еда."));
      return new Response("OK", { status: 200 });
    }

    // --------------------------
    // MAIN handler (amounts)
    // --------------------------
    if (threadId == null) return new Response("OK", { status: 200 });

    const parsed = parseMessage(text);
    if (!parsed) return new Response("OK", { status: 200 });

    const { amount_abs, note, sign } = parsed;
    const st = await getState();
    const when = nowStr();

    // ЕДА: отдельный бюджет
    if (threadId === FOOD_THREAD_ID) {
      const old_food = st.food_cents;
      let new_food, direction, last;

      if (sign >= 0) {
        new_food = old_food - amount_abs;
        direction = "out";
        last = `🍽 <b>Еда</b>: ${money(old_food)} - ${money(amount_abs)} = <b>${money(new_food)}</b>\n📝 ${note}\n🕒 ${when}`;
      } else {
        new_food = old_food + amount_abs;
        direction = "in";
        last = `🍽 <b>Еда</b>: ${money(old_food)} + ${money(amount_abs)} = <b>${money(new_food)}</b>\n📝 ${note}\n🕒 ${when}`;
      }

      st.food_cents = new_food;
      await saveState(st);
      await addEntry({ thread_id: threadId, category: "food", amount_cents: amount_abs, direction, note, created_at: when });

      await postBalance(buildBalanceText(st, last));
      await tg("sendMessage", { chat_id: chatId, message_thread_id: threadId, text: "Записал ✅" });
      return new Response("OK", { status: 200 });
    }

    // ПОПОЛНЕНИЕ: в общий
    if (threadId === TOPUP_THREAD_ID) {
      const old_total = st.total_cents;
      let new_total, direction, last;

      if (sign >= 0) {
        new_total = old_total + amount_abs;
        direction = "in";
        last = `➕ <b>Пополнение</b>: ${money(old_total)} + ${money(amount_abs)} = <b>${money(new_total)}</b>\n📝 ${note}\n🕒 ${when}`;
      } else {
        new_total = old_total - amount_abs;
        direction = "out";
        last = `➖ <b>Списание</b>: ${money(old_total)} - ${money(amount_abs)} = <b>${money(new_total)}</b>\n📝 ${note}\n🕒 ${when}`;
      }

      st.total_cents = new_total;
      await saveState(st);
      await addEntry({ thread_id: threadId, category: "topup", amount_cents: amount_abs, direction, note, created_at: when });

      await postBalance(buildBalanceText(st, last));
      await tg("sendMessage", { chat_id: chatId, message_thread_id: threadId, text: "Записал ✅" });
      return new Response("OK", { status: 200 });
    }

    //ПОПОЛНЕНИЕ: В ЕДУ
    if (threadId === FOOD_TOPUP_THREAD_ID) {
      const old_food = st.food_cents;
      let new_food, direction, last;
      
      if (sign >= 0) { // пополнение еды
        new_food = old_food + amount_abs;
        direction = "in";
        last = `🍽➕ <b>Пополнение еды</b>: ${money(old_food)} + ${money(amount_abs)} = <b>${money(new_food)}</b>\n📝 ${note}\n🕒 ${when}`;
      } else {         // списание еды (если ввели отрицательное)
        new_food = old_food - amount_abs;
        direction = "out";
        last = `🍽➖ <b>Списание еды</b>: ${money(old_food)} - ${money(amount_abs)} = <b>${money(new_food)}</b>\n📝 ${note}\n🕒 ${when}`;
      }
      
      st.food_cents = new_food;
      await saveState(st);
      await addEntry({ thread_id: threadId, category: "food_topup", amount_cents: amount_abs, direction, note, created_at: when });
      
      await postBalance(buildBalanceText(st, last));
      await tg("sendMessage", { chat_id: chatId, message_thread_id: threadId, text: "Записал ✅" });
      return new Response("OK", { status: 200 });
    }
    
    // КВАРТИРА и прочие расходы: общий
    if (threadId === APART_THREAD_ID || GENERAL_EXPENSE_THREADS.has(threadId)) {
      const category = threadId === APART_THREAD_ID ? "apart" : "total_other";
      const label = threadId === APART_THREAD_ID ? "🏠 <b>Квартира</b>" : "💰 <b>Расход</b>";

      const old_total = st.total_cents;
      let new_total, direction, last;

      if (sign >= 0) {
        new_total = old_total - amount_abs;
        direction = "out";
        last = `${label}: ${money(old_total)} - ${money(amount_abs)} = <b>${money(new_total)}</b>\n📝 ${note}\n🕒 ${when}`;
      } else {
        new_total = old_total + amount_abs;
        direction = "in";
        last = `${label}: ${money(old_total)} + ${money(amount_abs)} = <b>${money(new_total)}</b>\n📝 ${note}\n🕒 ${when}`;
      }

      st.total_cents = new_total;
      await saveState(st);
      await addEntry({ thread_id: threadId, category, amount_cents: amount_abs, direction, note, created_at: when });

      await postBalance(buildBalanceText(st, last));
      await tg("sendMessage", { chat_id: chatId, message_thread_id: threadId, text: "Записал ✅" });
      return new Response("OK", { status: 200 });
    }

    // Неизвестная тема — игнор
    return new Response("OK", { status: 200 });
  },
};
