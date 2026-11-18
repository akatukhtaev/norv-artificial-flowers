export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const cors = {
      "Access-Control-Allow-Origin": env.SITE_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization"
    };

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...cors
        }
      });

    if (method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (path === "/api/health" && method === "GET") {
        return json({ ok: true, service: "NORV API" });
      }

      if (path === "/api/products" && method === "GET") {
        const { results } = await env.DB.prepare(`
          SELECT
            p.*,
            c.name AS category_name,
            p.retail_price AS price,
            p.package_price AS packPrice,
            p.package_quantity AS packQty,
            p.wholesale_price AS bulkPrice,
            p.wholesale_minimum AS bulkMin,
            p.image_url AS image,
            c.name AS category
          FROM products p
          LEFT JOIN categories c ON c.id = p.category_id
          WHERE p.is_active = 1
          ORDER BY p.created_at DESC
        `).all();

        return json({
          products: results.map(p => ({
            ...p,
            types: parseTypes(p.types)
          }))
        });
      }

      if (path === "/api/login" && method === "POST") {
        const body = await request.json();

        if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
          return json({ error: "ÐÐµ Ð½Ð°ÑÑÑÐ¾ÐµÐ½Ñ ÑÐµÐºÑÐµÑÑ Ð°Ð´Ð¼Ð¸Ð½Ð¸ÑÑÑÐ°ÑÐ¾ÑÐ°" }, 500);
        }

        if (body.password !== env.ADMIN_PASSWORD) {
          return json({ error: "ÐÐµÐ²ÐµÑÐ½ÑÐ¹ Ð¿Ð°ÑÐ¾Ð»Ñ" }, 401);
        }

        const token = await signToken(env.SESSION_SECRET);

        return json({ token });
      }

      if (path === "/api/orders" && method === "POST") {
        const body = await request.json();

        const customer = body.customer || body;
        const items = body.items;

        if (
          !customer.name ||
          !customer.phone ||
          !Array.isArray(items) ||
          items.length === 0 ||
          items.length > 30
        ) {
          return json({ error: "ÐÑÐ¾Ð²ÐµÑÑÑÐµ Ð¸Ð¼Ñ, ÑÐµÐ»ÐµÑÐ¾Ð½ Ð¸ ÑÐ¾Ð²Ð°ÑÑ" }, 400);
        }

        const delivery = body.delivery_method;
        const address = String(body.delivery_address || "").trim();

        if (!["courier", "pickup"].includes(delivery)) {
          return json({ error: "ÐÑÐ±ÐµÑÐ¸ÑÐµ ÑÐ¿Ð¾ÑÐ¾Ð± Ð¿Ð¾Ð»ÑÑÐµÐ½Ð¸Ñ" }, 400);
        }

        if (delivery === "courier" && !address) {
          return json({ error: "Ð£ÐºÐ°Ð¶Ð¸ÑÐµ Ð°Ð´ÑÐµÑ Ð´Ð¾ÑÑÐ°Ð²ÐºÐ¸" }, 400);
        }

        const payment = "cash_on_delivery";
        const preparedItems = [];
        let total = 0;

        for (const item of items) {
          const productId = Number(item.product_id ?? item.id);
          const quantity = Number(item.quantity);
          const priceType = item.price_type || "piece";

          if (
            !Number.isInteger(productId) ||
            !Number.isInteger(quantity) ||
            quantity < 1 ||
            quantity > 10000
          ) {
            return json({ error: "ÐÐµÐºÐ¾ÑÑÐµÐºÑÐ½ÑÐ¹ ÑÐ¾Ð²Ð°Ñ Ð¸Ð»Ð¸ ÐºÐ¾Ð»Ð¸ÑÐµÑÑÐ²Ð¾" }, 400);
          }

          if (!["piece", "pack", "bulk"].includes(priceType)) {
            return json({ error: "ÐÐµÐºÐ¾ÑÑÐµÐºÑÐ½ÑÐ¹ ÑÐ¸Ð¿ ÑÐµÐ½Ñ" }, 400);
          }

          const product = await env.DB.prepare(`
            SELECT id, name, sku, retail_price, package_price,
                   package_quantity, wholesale_price, wholesale_minimum,
                   stock, is_active
            FROM products
            WHERE id = ?
          `).bind(productId).first();

          if (!product || !product.is_active) {
            return json({ error: "ÐÐ´Ð¸Ð½ Ð¸Ð· ÑÐ¾Ð²Ð°ÑÐ¾Ð² Ð½ÐµÐ´Ð¾ÑÑÑÐ¿ÐµÐ½" }, 400);
          }

          let price;

          if (priceType === "piece") {
            price = Number(product.retail_price);
          } else if (priceType === "pack") {
            price = Number(product.package_price);

            if (!price || price <= 0) {
              return json({
                error: `ÐÐ»Ñ ÑÐ¾Ð²Ð°ÑÐ° ${product.name} Ð½Ðµ Ð·Ð°Ð´Ð°Ð½Ð° ÑÐµÐ½Ð° ÑÐ¿Ð°ÐºÐ¾Ð²ÐºÐ¸`
              }, 400);
            }
          } else {
            price = Number(product.wholesale_price);

            if (
              !price ||
              price <= 0 ||
              quantity < Number(product.wholesale_minimum || 50)
            ) {
              return json({
                error: `ÐÐ»Ñ Ð¾Ð¿ÑÐ¾Ð²Ð¾Ð¹ ÑÐµÐ½Ñ ÑÐ¾Ð²Ð°ÑÐ° ${product.name} Ð½ÑÐ¶Ð½Ð¾ Ð¼Ð¸Ð½Ð¸Ð¼ÑÐ¼ ${product.wholesale_minimum} ÑÑ.`
              }, 400);
            }
          }

          total += price * quantity;

          preparedItems.push({
  id: product.id,
  name: product.name,
  sku: product.sku || "",
  quantity,
  price,
  priceType,
  stockQuantity: quantity * (
    priceType === "pack"
      ? Number(product.package_quantity || 1)
      : 1
  )
});
        }

        const customerResult = await env.DB.prepare(`
          INSERT INTO customers (name, phone, email)
          VALUES (?, ?, ?)
        `).bind(
          String(customer.name).trim(),
          String(customer.phone).trim(),
          String(customer.email || "").trim()
        ).run();

        const customerId = customerResult.meta.last_row_id;

        const orderResult = await env.DB.prepare(`
          INSERT INTO orders
          (customer_id, status, total, comment,
           delivery_method, delivery_address, payment_method)
          VALUES (?, 'new', ?, ?, ?, ?, ?)
        `).bind(
          customerId,
          total,
          String(body.comment || "").trim(),
          delivery,
          address,
          payment
        ).run();

        const orderId = orderResult.meta.last_row_id;

        for (const item of preparedItems) {
  await env.DB.prepare(`
    INSERT INTO order_items
    (order_id, product_id, quantity, price,
     product_name, sku, price_type, stock_quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    orderId,
    item.id,
    item.quantity,
    item.price,
    item.name,
    item.sku,
    item.priceType,
    item.stockQuantity
  ).run();
}

        const telegramText = [
          `<b>ð· NORV â ÐÐÐÐ«Ð ÐÐÐÐÐ â${orderId}</b>`,
          "",
          `<b>ÐÐ¾ÐºÑÐ¿Ð°ÑÐµÐ»Ñ:</b> ${escapeHtml(customer.name)}`,
          `<b>Ð¢ÐµÐ»ÐµÑÐ¾Ð½:</b> ${escapeHtml(customer.phone)}`,
          `<b>ÐÐ¾Ð»ÑÑÐµÐ½Ð¸Ðµ:</b> ${delivery === "courier" ? "ÐÑÑÑÐµÑ" : "Ð¡Ð°Ð¼Ð¾Ð²ÑÐ²Ð¾Ð·"}`,
          delivery === "courier"
            ? `<b>ÐÐ´ÑÐµÑ:</b> ${escapeHtml(address)}`
            : "",
          `<b>ÐÐ¿Ð»Ð°ÑÐ°:</b> ÐÐ°Ð»Ð¸ÑÐ½ÑÐ¼Ð¸ Ð¿ÑÐ¸ Ð¿Ð¾Ð»ÑÑÐµÐ½Ð¸Ð¸`,
          "",
          "<b>Ð¢Ð¾Ð²Ð°ÑÑ:</b>",
          ...preparedItems.map(item =>
            `â¢ ${escapeHtml(item.name)} â ${item.quantity} Ã ${item.priceType} â ${formatMoney(item.price * item.quantity)}`
          ),
          "",
          `<b>ÐÑÐ¾Ð³Ð¾: ${formatMoney(total)}</b>`,
          body.comment
            ? `\n<b>ÐÐ¾Ð¼Ð¼ÐµÐ½ÑÐ°ÑÐ¸Ð¹:</b> ${escapeHtml(body.comment)}`
            : ""
        ].filter(Boolean).join("\n");

        try {
          await telegram(env, "sendMessage", {
            chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
            text: telegramText,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[
                {
                  text: "â ÐÑÐ¸Ð½ÑÑÑ",
                  callback_data: `order:accept:${orderId}`
                },
                {
                  text: "â ÐÑÐºÐ»Ð¾Ð½Ð¸ÑÑ",
                  callback_data: `order:reject:${orderId}`
                }
              ]]
            }
          });
        } catch (error) {
          console.error("Telegram notification error:", error.message);
        }

        return json({
          ok: true,
          order_id: orderId,
          total,
          message: "ÐÐ°ÐºÐ°Ð· ÑÐ¾ÑÑÐ°Ð½ÑÐ½"
        }, 201);
      }

      if (path === "/api/telegram/webhook" && method === "POST") {
        const receivedSecret = request.headers.get(
          "X-Telegram-Bot-Api-Secret-Token"
        );

        if (
          !env.TELEGRAM_WEBHOOK_SECRET ||
          receivedSecret !== env.TELEGRAM_WEBHOOK_SECRET
        ) {
          return json({ error: "Unauthorized" }, 401);
        }

        const update = await request.json();
        const callback = update.callback_query;

        // Handle regular bot messages and commands.
        // The admin bot is intentionally restricted to the configured admin chat.
        if (!callback) {
          const message = update.message;
          if (!message?.chat?.id) {
            return json({ ok: true });
          }

          const chatId = String(message.chat.id);
          const text = String(message.text || "").trim();
          const isAdmin = Boolean(env.TELEGRAM_ADMIN_CHAT_ID) &&
            chatId === String(env.TELEGRAM_ADMIN_CHAT_ID);

          if (!isAdmin) {
            await telegram(env, "sendMessage", {
              chat_id: chatId,
              text: "â ÐÐ¾ÑÑÑÐ¿ Ðº ÑÐ¿ÑÐ°Ð²Ð»ÐµÐ½Ð¸Ñ NORV Ð¾Ð³ÑÐ°Ð½Ð¸ÑÐµÐ½."
            });
            return json({ ok: true });
          }

          if (/^\/(start|help)(@\w+)?(?:\s|$)/i.test(text)) {
            await telegram(env, "sendMessage", {
              chat_id: chatId,
              text: [
                "ð· <b>NORV â Ð¿Ð°Ð½ÐµÐ»Ñ ÑÐ²ÐµÐ´Ð¾Ð¼Ð»ÐµÐ½Ð¸Ð¹</b>",
                "",
                "ÐÐ¾Ñ Ð¿Ð¾Ð´ÐºÐ»ÑÑÑÐ½ Ð¸ Ð³Ð¾ÑÐ¾Ð² Ð¾ÑÐ¿ÑÐ°Ð²Ð»ÑÑÑ ÑÐ²ÐµÐ´Ð¾Ð¼Ð»ÐµÐ½Ð¸Ñ Ð¾ Ð·Ð°ÐºÐ°Ð·Ð°Ñ.",
                "",
                "ÐÐ¾Ð³Ð´Ð° Ð¿Ð¾ÑÑÑÐ¿Ð¸Ñ Ð½Ð¾Ð²ÑÐ¹ Ð·Ð°ÐºÐ°Ð·, Ð·Ð´ÐµÑÑ Ð¿Ð¾ÑÐ²Ð¸ÑÑÑ ÐºÐ°ÑÑÐ¾ÑÐºÐ° Ñ ÐºÐ½Ð¾Ð¿ÐºÐ°Ð¼Ð¸:",
                "â ÐÑÐ¸Ð½ÑÑÑ â Ð¿Ð¾Ð´ÑÐ²ÐµÑÐ´Ð¸ÑÑ Ð·Ð°ÐºÐ°Ð· Ð¸ ÑÐ¿Ð¸ÑÐ°ÑÑ ÑÐ¾Ð²Ð°Ñ ÑÐ¾ ÑÐºÐ»Ð°Ð´Ð°.",
                "â ÐÑÐºÐ»Ð¾Ð½Ð¸ÑÑ â Ð¾ÑÐºÐ»Ð¾Ð½Ð¸ÑÑ Ð·Ð°ÐºÐ°Ð· Ð±ÐµÐ· ÑÐ¿Ð¸ÑÐ°Ð½Ð¸Ñ ÑÐ¾Ð²Ð°ÑÐ°.",
                "",
                "ÐÐ¾Ð¼Ð°Ð½Ð´Ñ: /start, /help"
              ].join("\n"),
              parse_mode: "HTML"
            });
          } else {
            await telegram(env, "sendMessage", {
              chat_id: chatId,
              text: "Ð¯ Ð½Ð° ÑÐ²ÑÐ·Ð¸! ð· ÐÐ»Ñ ÑÐ¿ÑÐ°Ð²ÐºÐ¸ Ð¾ÑÐ¿ÑÐ°Ð²Ñ /help. ÐÐ¾Ð²ÑÐµ Ð·Ð°ÐºÐ°Ð·Ñ Ð¸Ð· Ð¼Ð°Ð³Ð°Ð·Ð¸Ð½Ð° Ð±ÑÐ´ÑÑ Ð¿ÑÐ¸ÑÐ¾Ð´Ð¸ÑÑ ÑÑÐ´Ð° Ð°Ð²ÑÐ¾Ð¼Ð°ÑÐ¸ÑÐµÑÐºÐ¸."
            });
          }

          return json({ ok: true });
        }

        const chatId = String(callback.message?.chat?.id || "");

        if (
          !env.TELEGRAM_ADMIN_CHAT_ID ||
          chatId !== String(env.TELEGRAM_ADMIN_CHAT_ID)
        ) {
          await telegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "ÐÐµÑ Ð´Ð¾ÑÑÑÐ¿Ð°",
            show_alert: true
          });

          return json({ ok: true });
        }

        const match = /^order:(accept|reject):(\d+)$/.exec(
          callback.data || ""
        );

        if (!match) {
          return json({ ok: true });
        }

        const action = match[1];
        const orderId = Number(match[2]);
        const status = action === "accept" ? "accepted" : "rejected";

     let result;

try {
  result = await env.DB.prepare(`
    UPDATE orders
    SET status = ?
    WHERE id = ? AND status = 'new'
  `).bind(status, orderId).run();

} catch (error) {
  console.error("Order status update error:", error);

  const insufficientStock =
    String(error.message || "").includes("INSUFFICIENT_STOCK");

  await telegram(env, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: insufficientStock
      ? "â ÐÐµÐ´Ð¾ÑÑÐ°ÑÐ¾ÑÐ½Ð¾ ÑÐ¾Ð²Ð°ÑÐ° Ð½Ð° ÑÐºÐ»Ð°Ð´Ðµ!"
      : "â ï¸ ÐÑÐ¸Ð±ÐºÐ° Ð¾Ð±ÑÐ°Ð±Ð¾ÑÐºÐ¸ Ð·Ð°ÐºÐ°Ð·Ð°. ÐÐ¾Ð¿ÑÐ¾Ð±ÑÐ¹ÑÐµ Ð¿Ð¾Ð·Ð¶Ðµ.",
    show_alert: true
  });

  return json({ ok: false, error: "ÐÐµ ÑÐ´Ð°Ð»Ð¾ÑÑ Ð¾Ð±ÑÐ°Ð±Ð¾ÑÐ°ÑÑ Ð·Ð°ÐºÐ°Ð·" });
}

        if (!result.meta.changes) {
          await telegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "ÐÐ°ÐºÐ°Ð· ÑÐ¶Ðµ Ð¾Ð±ÑÐ°Ð±Ð¾ÑÐ°Ð½"
          });

          return json({ ok: true });
        }

        await telegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: action === "accept"
            ? "ÐÐ°ÐºÐ°Ð· Ð¿ÑÐ¸Ð½ÑÑ"
            : "ÐÐ°ÐºÐ°Ð· Ð¾ÑÐºÐ»Ð¾Ð½ÑÐ½"
        });

        const oldText = callback.message?.text || "";
        const newText = oldText +
          (action === "accept"
            ? "\n\nâ <b>ÐÐÐÐÐ ÐÐ ÐÐÐ¯Ð¢</b>"
            : "\n\nâ <b>ÐÐÐÐÐ ÐÐ¢ÐÐÐÐÐÐ</b>");

        await telegram(env, "editMessageText", {
          chat_id: chatId,
          message_id: callback.message.message_id,
          text: newText,
          parse_mode: "HTML"
        });

        return json({ ok: true });
      }

      if (path === "/api/orders" && method === "GET") {
        if (!await authorized(request, env)) {
          return json({ error: "Ð¢ÑÐµÐ±ÑÐµÑÑÑ Ð²ÑÐ¾Ð´ Ð°Ð´Ð¼Ð¸Ð½Ð¸ÑÑÑÐ°ÑÐ¾ÑÐ°" }, 401);
        }

        const { results } = await env.DB.prepare(`
          SELECT
            o.*,
            c.name AS customer_name,
            c.phone AS customer_phone,
            c.email AS customer_email
          FROM orders o
          LEFT JOIN customers c ON c.id = o.customer_id
          ORDER BY o.created_at DESC
          LIMIT 200
        `).all();

        return json({ orders: results });
      }

      if (path.startsWith("/api/products") && method !== "GET") {
        if (!await authorized(request, env)) {
          return json({ error: "Ð¢ÑÐµÐ±ÑÐµÑÑÑ Ð²ÑÐ¾Ð´ Ð°Ð´Ð¼Ð¸Ð½Ð¸ÑÑÑÐ°ÑÐ¾ÑÐ°" }, 401);
        }

        if (path === "/api/products" && method === "POST") {
          const p = await request.json();
          validateProduct(p);

          const slug = makeSlug(p.slug || p.name);
          const types = JSON.stringify(
            p.types || ["piece", "pack", "bulk"]
          );

          const result = await env.DB.prepare(`
            INSERT INTO products (
              name, slug, sku, description, category_id,
              retail_price, package_price, wholesale_price,
              image_url, stock, is_active, package_quantity,
              wholesale_minimum, unit, badge, types
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
          `).bind(
            p.name.trim(),
            `${slug}-${Date.now()}`,
            p.sku || "",
            p.description || "",
            p.category_id || null,
            Number(p.retail_price ?? p.price),
            Number(p.package_price ?? p.packPrice ?? 0),
            Number(p.wholesale_price ?? p.bulkPrice ?? 0),
            p.image_url || p.image || "",
            Number(p.stock || 0),
            Number(p.package_quantity ?? p.packQty ?? 10),
            Number(p.wholesale_minimum ?? p.bulkMin ?? 50),
            p.unit || "ÑÑ.",
            p.badge || "",
            types
          ).run();

          return json({ ok: true, id: result.meta.last_row_id }, 201);
        }

        const id = Number(path.split("/").pop());

        if (!Number.isInteger(id) || id < 1) {
          return json({ error: "ÐÐµÐºÐ¾ÑÑÐµÐºÑÐ½ÑÐ¹ ID" }, 400);
        }

        if (method === "PUT") {
          const p = await request.json();
          validateProduct(p);

          await env.DB.prepare(`
            UPDATE products SET
              name = ?,
              sku = ?,
              description = ?,
              category_id = ?,
              retail_price = ?,
              package_price = ?,
              wholesale_price = ?,
              image_url = ?,
              stock = ?,
              package_quantity = ?,
              wholesale_minimum = ?,
              unit = ?,
              badge = ?,
              types = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(
            p.name.trim(),
            p.sku || "",
            p.description || "",
            p.category_id || null,
            Number(p.retail_price ?? p.price),
            Number(p.package_price ?? p.packPrice ?? 0),
            Number(p.wholesale_price ?? p.bulkPrice ?? 0),
            p.image_url || p.image || "",
            Number(p.stock || 0),
            Number(p.package_quantity ?? p.packQty ?? 10),
            Number(p.wholesale_minimum ?? p.bulkMin ?? 50),
            p.unit || "ÑÑ.",
            p.badge || "",
            JSON.stringify(p.types || ["piece", "pack", "bulk"]),
            id
          ).run();

          return json({ ok: true });
        }

        if (method === "DELETE") {
          await env.DB.prepare(`
            UPDATE products SET is_active = 0
            WHERE id = ?
          `).bind(id).run();

          return json({ ok: true });
        }
      }

      return json({ error: "Not found" }, 404);

    } catch (error) {
      console.error("NORV API error:", error);
      return json({
        error: error.message || "Server error"
      }, 500);
    }
  }
};

function parseTypes(value) {
  try {
    return JSON.parse(value || '["piece","pack","bulk"]');
  } catch {
    return ["piece", "pack", "bulk"];
  }
}

function validateProduct(p) {
  const price = Number(p?.retail_price ?? p?.price);

  if (
    !p ||
    typeof p.name !== "string" ||
    !p.name.trim() ||
    !Number.isFinite(price) ||
    price < 0
  ) {
    throw new Error("Ð£ÐºÐ°Ð¶Ð¸ÑÐµ Ð½Ð°Ð·Ð²Ð°Ð½Ð¸Ðµ Ð¸ ÐºÐ¾ÑÑÐµÐºÑÐ½ÑÑ ÑÐ¾Ð·Ð½Ð¸ÑÐ½ÑÑ ÑÐµÐ½Ñ");
  }
}

function makeSlug(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9Ð°-ÑÑ]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "product";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function formatMoney(value) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 2
  }).format(value) + " â½";
}

async function telegram(env, method, data) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN Ð½Ðµ Ð½Ð°ÑÑÑÐ¾ÐµÐ½");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(result.description || "ÐÑÐ¸Ð±ÐºÐ° Telegram API");
  }

  return result;
}

async function signToken(secret) {
  const expiry = Date.now() + 8 * 60 * 60 * 1000;
  const data = `${expiry}.${crypto.randomUUID()}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );

  return btoa(data) + "." +
    btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function authorized(request, env) {
  try {
    if (!env.SESSION_SECRET) return false;

    const token = (request.headers.get("Authorization") || "")
      .replace(/^Bearer\s+/i, "");

    const parts = token.split(".");
    if (parts.length !== 2) return false;

    const data = atob(parts[0]);
    const expiry = Number(data.split(".")[0]);

    if (!Number.isFinite(expiry) || expiry < Date.now()) {
      return false;
    }

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.SESSION_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const signature = Uint8Array.from(
      atob(parts[1]),
      char => char.charCodeAt(0)
    );

    return crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(data)
    );
  } catch {
    return false;
  }
}
