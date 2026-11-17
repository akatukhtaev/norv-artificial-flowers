
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
          return json({ error: "Не настроены секреты администратора" }, 500);
        }

        if (body.password !== env.ADMIN_PASSWORD) {
          return json({ error: "Неверный пароль" }, 401);
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
          return json({ error: "Проверьте имя, телефон и товары" }, 400);
        }

        const delivery = body.delivery_method;
        const address = String(body.delivery_address || "").trim();

        if (!["courier", "pickup"].includes(delivery)) {
          return json({ error: "Выберите способ получения" }, 400);
        }

        if (delivery === "courier" && !address) {
          return json({ error: "Укажите адрес доставки" }, 400);
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
            return json({ error: "Некорректный товар или количество" }, 400);
          }

          if (!["piece", "pack", "bulk"].includes(priceType)) {
            return json({ error: "Некорректный тип цены" }, 400);
          }

          const product = await env.DB.prepare(`
            SELECT id, name, sku, retail_price, package_price,
                   package_quantity, wholesale_price, wholesale_minimum,
                   stock, is_active
            FROM products
            WHERE id = ?
          `).bind(productId).first();

          if (!product || !product.is_active) {
            return json({ error: "Один из товаров недоступен" }, 400);
          }

          let price;

          if (priceType === "piece") {
            price = Number(product.retail_price);
          } else if (priceType === "pack") {
            price = Number(product.package_price);

            if (!price || price <= 0) {
              return json({
                error: `Для товара ${product.name} не задана цена упаковки`
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
                error: `Для оптовой цены товара ${product.name} нужно минимум ${product.wholesale_minimum} шт.`
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
          `<b>🌷 NORV — НОВЫЙ ЗАКАЗ №${orderId}</b>`,
          "",
          `<b>Покупатель:</b> ${escapeHtml(customer.name)}`,
          `<b>Телефон:</b> ${escapeHtml(customer.phone)}`,
          `<b>Получение:</b> ${delivery === "courier" ? "Курьер" : "Самовывоз"}`,
          delivery === "courier"
            ? `<b>Адрес:</b> ${escapeHtml(address)}`
            : "",
          `<b>Оплата:</b> Наличными при получении`,
          "",
          "<b>Товары:</b>",
          ...preparedItems.map(item =>
            `• ${escapeHtml(item.name)} — ${item.quantity} × ${item.priceType} — ${formatMoney(item.price * item.quantity)}`
          ),
          "",
          `<b>Итого: ${formatMoney(total)}</b>`,
          body.comment
            ? `\n<b>Комментарий:</b> ${escapeHtml(body.comment)}`
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
                  text: "✅ Принять",
                  callback_data: `order:accept:${orderId}`
                },
                {
                  text: "❌ Отклонить",
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
          message: "Заказ сохранён"
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

        if (!callback) {
          return json({ ok: true });
        }

        const chatId = String(callback.message?.chat?.id || "");

        if (
          !env.TELEGRAM_ADMIN_CHAT_ID ||
          chatId !== String(env.TELEGRAM_ADMIN_CHAT_ID)
        ) {
          await telegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "Нет доступа",
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
      ? "❌ Недостаточно товара на складе!"
      : "⚠️ Ошибка обработки заказа. Попробуйте позже.",
    show_alert: true
  });

  return json({ ok: false, error: "Не удалось обработать заказ" });
}

        if (!result.meta.changes) {
          await telegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "Заказ уже обработан"
          });

          return json({ ok: true });
        }

        await telegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: action === "accept"
            ? "Заказ принят"
            : "Заказ отклонён"
        });

        const oldText = callback.message?.text || "";
        const newText = oldText +
          (action === "accept"
            ? "\n\n✅ <b>ЗАКАЗ ПРИНЯТ</b>"
            : "\n\n❌ <b>ЗАКАЗ ОТКЛОНЁН</b>");

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
          return json({ error: "Требуется вход администратора" }, 401);
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
          return json({ error: "Требуется вход администратора" }, 401);
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
            p.unit || "шт.",
            p.badge || "",
            types
          ).run();

          return json({ ok: true, id: result.meta.last_row_id }, 201);
        }

        const id = Number(path.split("/").pop());

        if (!Number.isInteger(id) || id < 1) {
          return json({ error: "Некорректный ID" }, 400);
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
            p.unit || "шт.",
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
    throw new Error("Укажите название и корректную розничную цену");
  }
}

function makeSlug(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
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
  }).format(value) + " ₽";
}

async function telegram(env, method, data) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN не настроен");
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
    throw new Error(result.description || "Ошибка Telegram API");
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
