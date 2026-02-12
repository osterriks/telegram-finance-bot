export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    const update = await request.json().catch(() => null);
    const msg = update?.message;
    if (!msg?.chat?.id) return new Response("OK", { status: 200 });

    const chatId = msg.chat.id;
    const threadId = msg.message_thread_id ?? null;
    const text = (msg.text ?? "").trim();

    // --- config from env (Cloudflare Variables) ---
    const BAL = parseInt(env.BALANCE_THREAD_ID || "0", 10);
    const FOOD = parseInt(env.FOOD_THREAD_ID || "0", 10);
    const APART = parseInt(env.APART_THREAD_ID || "0", 10);
    const TOPUP = parseInt(env.TOPUP_THREAD_ID || "0", 10);

    const generalSet = new Set(
      String(env.GENERAL_EXPENSE_THREADS || "")
        .split(",")
        .map((x) => parseInt(x.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
    );

    // --- helpers ---
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
      if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN missing (set it in Settings → Variables → Secrets)");
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(`${method} failed: ${JSON.stringify(data)}`);
      return data.result;
    };

    // --- /where ---
    if (text === "/where") {
      await tg("sendMessage", {
        chat_id: chatId,
        message_thread_id: threadId ?? undefined,
        text: `chat_id=${chatId}\nthread_id=${threadId}`,
      });
      return new Response("OK", { status: 200 });
    }

    // --- KV keys (per chat) ---
    const kTotal = `total:${chatId}`;
    const kFood = `food:${chatId}`;
    const kBalMsg = `balmsg:${chatId}`;

    const getInt = async (key, def) => {
      const v = await env.KV.get(key);
      if (v == null) return def;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : def;
    };
    const setInt = async (key, val) => env.KV.put(key, String(val));

    // defaults
    let total = await getInt(kTotal, 0);
    let food = await getInt(kFood, 2000000); // 20000.00 default
    let balMsgId = await env.KV.get(kBalMsg); // stored message id in Balance topic

    const buildBalanceText = (lastLine) => {
      let out =
        `📌 <b>Баланс</b>\n` +
        `💰 <b>Общий:</b> ${money(total)}\n` +
        `🍽 <b>Еда:</b> ${money(food)}\n` +
        `🕒 ${nowStr()}`;
      if (lastLine) out += `\n\n${lastLine}`;
      return out;
    };

    const editOrSendBalance = async (payloadText) => {
      if (!BAL) return; // not configured
      if (balMsgId) {
        try {
          await tg("editMessageText", {
            chat_id: chatId,
            message_thread_id: BAL,
            message_id: parseInt(balMsgId, 10),
            text: payloadText,
            parse_mode: "HTML",
          });
          return;
        } catch (_) {
          // fall through to send
        }
      }
      const sent = await tg("sendMessage", {
        chat_id: chatId,
        message_thread_id: BAL,
        text: payloadText,
        parse_mode: "HTML",
      });
      balMsgId = String(sent.message_id);
      await env.KV.put(kBalMsg, balMsgId);
    };

    // --- commands in Balance topic ---
    if (threadId === BAL && text.startsWith("/settotal")) {
      const arg = text.split(/\s+/, 2)[1];
      if (!arg) {
        await tg("sendMessage", { chat_id: chatId, message_thread_id: BAL, text: "Формат: /settotal 50000.00" });
        return new Response("OK", { status: 200 });
      }
      total = toCents(arg).abs;
      await setInt(kTotal, total);
      await editOrSendBalance(buildBalanceText("✅ Установлен общий баланс."));
      return new Response("OK", { status: 200 });
    }

    if (threadId === BAL && text.startsWith("/setfood")) {
      const arg = text.split(/\s+/, 2)[1];
      if (!arg) {
        await tg("sendMessage", { chat_id: chatId, message_thread_id: BAL, text: "Формат: /setfood 20000.00" });
        return new Response("OK", { status: 200 });
      }
      food = toCents(arg).abs;
      await setInt(kFood, food);
      await editOrSendBalance(buildBalanceText("✅ Установлен бюджет Еда."));
      return new Response("OK", { status: 200 });
    }

    // --- parse entries: "2453.13 note" ---
    if (!text || threadId == null) return new Response("OK", { status: 200 });
    const m = text.match(/^\s*([+-]?\d[\d\s]*([.,]\d{1,2})?)\s*(.*)$/);
    if (!m) return new Response("OK", { status: 200 });

    const note = (m[3] || "").trim();
    let parsed;
    try {
      parsed = toCents(m[1]);
    } catch {
      return new Response("OK", { status: 200 });
    }
    const abs = parsed.abs;
    const sign = parsed.sign; // +1 or -1
    const when = nowStr();

    let lastLine = "";

    // Еда: отдельный, общий не трогаем
    if (threadId === FOOD) {
      const old = food;
      if (sign === 1) {
        food = old - abs;
        lastLine = `🍽 <b>Еда</b>: ${money(old)} - ${money(abs)} = <b>${money(food)}</b>\n📝 ${note}\n🕒 ${when}`;
      } else {
        food = old + abs;
        lastLine = `🍽 <b>Еда</b>: ${money(old)} + ${money(abs)} = <b>${money(food)}</b>\n📝 ${note}\n🕒 ${when}`;
      }
      await setInt(kFood, food);
      await editOrSendBalance(buildBalanceText(lastLine));
      return new Response("OK", { status: 200 });
    }

    // Пополнение: влияет на общий (плюс = доход)
    if (threadId === TOPUP) {
      const old = total;
      if (sign === 1) {
        total = old + abs;
        lastLine = `➕ <b>Пополнение</b>: ${money(old)} + ${money(abs)} = <b>${money(total)}</b>\n📝 ${note}\n🕒 ${when}`;
      } else {
        total = old - abs;
        lastLine = `➖ <b>Списание</b>: ${money(old)} - ${money(abs)} = <b>${money(total)}</b>\n📝 ${note}\n🕒 ${when}`;
      }
      await setInt(kTotal, total);
      await editOrSendBalance(buildBalanceText(lastLine));
      return new Response("OK", { status: 200 });
    }

    // Квартира и прочие расходы: уменьшают общий
    if (threadId === APART || generalSet.has(threadId)) {
      const label = threadId === APART ? "🏠 <b>Квартира</b>" : "💰 <b>Расход</b>";
      const old = total;
      if (sign === 1) {
        total = old - abs;
        lastLine = `${label}: ${money(old)} - ${money(abs)} = <b>${money(total)}</b>\n📝 ${note}\n🕒 ${when}`;
      } else {
        total = old + abs;
        lastLine = `${label}: ${money(old)} + ${money(abs)} = <b>${money(total)}</b>\n📝 ${note}\n🕒 ${when}`;
      }
      await setInt(kTotal, total);
      await editOrSendBalance(buildBalanceText(lastLine));
      return new Response("OK", { status: 200 });
    }

    return new Response("OK", { status: 200 });
  },
};
