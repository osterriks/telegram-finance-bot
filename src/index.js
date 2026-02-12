export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    const update = await request.json().catch(() => null);
    const msg = update?.message;
    if (!msg?.chat?.id) return new Response("OK", { status: 200 });

    const chatId = msg.chat.id;
    const threadId = msg.message_thread_id ?? null;
    const text = (msg.text ?? "").trim();

    // ---------- helpers ----------
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

    const toCents = (amountStr) => {
      const s0 = String(amountStr).trim().replace(/\s+/g, "").replace(",", ".");
      if (!/^[+-]?\d+(\.\d{1,2})?$/.test(s0)) throw new Error("bad amount");
      const sign = s0.startsWith("-") ? -1 : 1;
      const s = s0.replace(/^[+-]/, "");
      const [a, bRaw] = s.split(".");
      const b = ((bRaw ?? "") + "00").slice(0, 2);
      const abs = parseInt(a, 10) * 100 + parseInt(b, 10);
      if (!Number.isFinite(abs) || abs === 0) throw new Error("bad amount");
      return { abs, sign };
    };

    const tg = async (method, body) => {
      if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN missing (Cloudflare → Settings → Variables → Secret)");
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(`${method} failed: ${JSON.stringify(data)}`);
      return data.result;
    };

    const getInt = async (key, def) => {
      const v = await env.KV.get(key);
      if (v == null) return def;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : def;
    };
    const setInt = async (key, val) => env.KV.put(key, String(val));

    const getStr = async (key, def = "") => {
      const v = await env.KV.get(key);
      return v == null ? def : v;
    };
    const setStr = async (key, val) => env.KV.put(key, val);

    // ---------- storage keys ----------
    const kTotal = `total:${chatId}`;
    const kFood = `food:${chatId}`;
    const kBalMsgId = `balmsg:${chatId}`;          // message_id pinned-like in "Баланс"
    const kThreadMap = `threads:${chatId}`;        // JSON: { "<threadId>": "Еда" ... }

    // defaults
    let total = await getInt(kTotal, 0);
    let food = await getInt(kFood, 2000000); // 20000.00 default
    let balMsgId = await getStr(kBalMsgId, "");

    // thread mapping
    const loadMap = async () => {
      const raw = await getStr(kThreadMap, "{}");
      try { return JSON.parse(raw); } catch { return {}; }
    };
    const saveMap = async (map) => setStr(kThreadMap, JSON.stringify(map));

    const buildBalanceText = (lastLine) => {
      let out =
        `📌 <b>Баланс</b>\n` +
        `💰 <b>Общий:</b> ${money(total)}\n` +
        `🍽 <b>Еда:</b> ${money(food)} (не влияет на общий)\n` +
        `🕒 ${nowStr()}`;
      if (lastLine) out += `\n\n${lastLine}`;
      return out;
    };

    // edit/send balance message into "Баланс" thread (we need its thread id)
    const ensureBalanceThreadId = async () => {
      const map = await loadMap();
      // try find thread_id where name is "Баланс" or "Balance"
      for (const [tid, name] of Object.entries(map)) {
        const n = String(name).toLowerCase();
        if (n === "баланс" || n === "balance") return parseInt(tid, 10);
      }
      return null;
    };

    const editOrSendBalance = async (balanceThreadId, payloadText) => {
      if (!balanceThreadId) return;
      if (balMsgId) {
        try {
          await tg("editMessageText", {
            chat_id: chatId,
            message_thread_id: balanceThreadId,
            message_id: parseInt(balMsgId, 10),
            text: payloadText,
            parse_mode: "HTML",
          });
          return;
        } catch (_) {}
      }
      const sent = await tg("sendMessage", {
        chat_id: chatId,
        message_thread_id: balanceThreadId,
        text: payloadText,
        parse_mode: "HTML",
      });
      balMsgId = String(sent.message_id);
      await setStr(kBalMsgId, balMsgId);
    };

    // ---------- COMMANDS ----------
    // /where => запоминаем thread_id как "имя темы" из первого слова сообщения после /where
    // Пример: в теме Еда пишешь "/where Еда" → запомнит threadId -> "Еда"
    // Если просто "/where" — ответит thread_id, но не запишет имя.
    if (text.startsWith("/where")) {
      const parts = text.split(/\s+/, 2);
      const label = (parts[1] || "").trim(); // optional name
      if (label && threadId != null) {
        const map = await loadMap();
        map[String(threadId)] = label;
        await saveMap(map);
        await tg("sendMessage", {
          chat_id: chatId,
          message_thread_id: threadId ?? undefined,
          text: `✅ Запомнил: thread_id=${threadId} → "${label}"`,
        });
      } else {
        await tg("sendMessage", {
          chat_id: chatId,
          message_thread_id: threadId ?? undefined,
          text: `chat_id=${chatId}\nthread_id=${threadId}\n\nЧтобы я запомнил тему, напиши: /where Еда (или /where Баланс и т.д.)`,
        });
      }
      return new Response("OK", { status: 200 });
    }

    // Команды баланса работают ТОЛЬКО если ты уже пометил тему "Баланс" через /where Баланс
    const balanceThreadId = await ensureBalanceThreadId();

    if (balanceThreadId && threadId === balanceThreadId && text.startsWith("/settotal")) {
      const arg = text.split(/\s+/, 2)[1];
      if (!arg) {
        await tg("sendMessage", { chat_id: chatId, message_thread_id: balanceThreadId, text: "Формат: /settotal 50000.00" });
        return new Response("OK", { status: 200 });
      }
      total = toCents(arg).abs;
      await setInt(kTotal, total);
      await editOrSendBalance(balanceThreadId, buildBalanceText("✅ Установлен общий баланс."));
      return new Response("OK", { status: 200 });
    }

    if (balanceThreadId && threadId === balanceThreadId && text.startsWith("/setfood")) {
      const arg = text.split(/\s+/, 2)[1];
      if (!arg) {
        await tg("sendMessage", { chat_id: chatId, message_thread_id: balanceThreadId, text: "Формат: /setfood 20000.00" });
        return new Response("OK", { status: 200 });
      }
      food = toCents(arg).abs;
      await setInt(kFood, food);
      await editOrSendBalance(balanceThreadId, buildBalanceText("✅ Установлен бюджет Еда."));
      return new Response("OK", { status: 200 });
    }

    // ---------- PARSE AMOUNT ----------
    if (!text || threadId == null) return new Response("OK", { status: 200 });
    const m = text.match(/^\s*([+-]?\d[\d\s]*([.,]\d{1,2})?)\s*(.*)$/);
    if (!m) return new Response("OK", { status: 200 });

    const note = (m[3] || "").trim();
    let parsed;
    try { parsed = toCents(m[1]); } catch { return new Response("OK", { status: 200 }); }
    const abs = parsed.abs;
    const sign = parsed.sign; // +1 / -1
    const when = nowStr();

    // determine category by saved topic name
    const map = await loadMap();
    const topicName = String(map[String(threadId)] || "").toLowerCase();

    // If not mapped, tell user how to map once
    if (!topicName) {
      await tg("sendMessage", {
        chat_id: chatId,
        message_thread_id: threadId,
        text:
          `Я не знаю, что это за тема.\n` +
          `Сделай один раз: /where Еда (или /where Квартира /where Пополнение /where Баланс)\n` +
          `Текущий thread_id=${threadId}`,
      });
      return new Response("OK", { status: 200 });
    }

    let lastLine = "";

    // ---------- LOGIC (как в main) ----------
    // Еда: отдельный бюджет (не трогает общий)
    if (topicName === "еда" || topicName === "food") {
      const old = food;
      if (sign === 1) {
        food = old - abs;
        lastLine = `🍽 <b>Еда</b>: ${money(old)} - ${money(abs)} = <b>${money(food)}</b>\n📝 ${note}\n🕒 ${when}`;
      } else {
        food = old + abs;
        lastLine = `🍽 <b>Еда</b>: ${money(old)} + ${money(abs)} = <b>${money(food)}</b>\n📝 ${note}\n🕒 ${when}`;
      }
      await setInt(kFood, food);
      if (balanceThreadId) await editOrSendBalance(balanceThreadId, buildBalanceText(lastLine));
      return new Response("OK", { status: 200 });
    }

    // Пополнение: увеличивает общий
    if (topicName === "пополнение" || topicName === "topup") {
      const old = total;
      if (sign === 1) {
        total = old + abs;
        lastLine = `➕ <b>Пополнение</b>: ${money(old)} + ${money(abs)} = <b>${money(total)}</b>\n📝 ${note}\n🕒 ${when}`;
      } else {
        total = old - abs;
        lastLine = `➖ <b>Списание</b>: ${money(old)} - ${money(abs)} = <b>${money(total)}</b>\n📝 ${note}\n🕒 ${when}`;
      }
      await setInt(kTotal, total);
      if (balanceThreadId) await editOrSendBalance(balanceThreadId, buildBalanceText(lastLine));
      return new Response("OK", { status: 200 });
    }

    // Квартира: расход -> уменьшает общий
    if (topicName === "квартира" || topicName === "rent" || topicName === "apartment") {
      const old = total;
      if (sign === 1) {
        total = old - abs;
        lastLine = `🏠 <b>Квартира</b>: ${money(old)} - ${money(abs)} = <b>${money(total)}</b>\n📝 ${note}\n🕒 ${when}`;
      } else {
        total = old + abs;
        lastLine = `🏠 <b>Квартира</b>: ${money(old)} + ${money(abs)} = <b>${money(total)}</b>\n📝 ${note}\n🕒 ${when}`;
      }
      await setInt(kTotal, total);
      if (balanceThreadId) await editOrSendBalance(balanceThreadId, buildBalanceText(lastLine));
      return new Response("OK", { status: 200 });
    }

    // Любая другая тема: считаем расходом из общего (как твои Путешествия/Для нас)
    {
      const old = total;
      if (sign === 1) {
        total = old - abs;
        lastLine = `💰 <b>${map[String(threadId)]}</b>: ${money(old)} - ${money(abs)} = <b>${money(total)}</b>\n📝 ${note}\n🕒 ${when}`;
      } else {
        total = old + abs;
        lastLine = `💰 <b>${map[String(threadId)]}</b>: ${money(old)} + ${money(abs)} = <b>${money(total)}</b>\n📝 ${note}\n🕒 ${when}`;
      }
      await setInt(kTotal, total);
      if (balanceThreadId) await editOrSendBalance(balanceThreadId, buildBalanceText(lastLine));
      return new Response("OK", { status: 200 });
    }
  },
};

