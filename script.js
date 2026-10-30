(() => {
  "use strict";

  const KEYS = {
    products: "shark-shop-products-v1",
    orders: "shark-shop-orders-v1",
    settings: "shark-shop-settings-v1"
  };
  const DEFAULT_SETTINGS = {
    storeName: "SHARK | SHOP | GURLAN",
    phone: "+998931150389",
    deliveryInfo: "Yetkazib berish vaqti buyurtma tasdiqlangandan so‘ng kelishiladi.",
    username: "",
    password: ""
  };
  const ORDER_STATUSES = ["Yangi", "Tasdiqlandi", "Tayyorlanmoqda", "Yetkazilmoqda", "Yetkazildi", "Bekor qilindi"];
  const SUPABASE_URL = typeof window.SHARK_SUPABASE_URL === "string" ? window.SHARK_SUPABASE_URL.replace(/\/$/, "") : "";
  const SUPABASE_ANON_KEY = typeof window.SHARK_SUPABASE_ANON_KEY === "string" ? window.SHARK_SUPABASE_ANON_KEY : "";
  const SUPABASE_ENABLED = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 20;
  const SUPABASE_SESSION_KEY = "shark-shop-supabase-session-v1";
  const API_BASE = typeof window.SHARK_API_BASE === "string" ? window.SHARK_API_BASE.replace(/\/$/, "") : "";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const formatPrice = (price) => `${new Intl.NumberFormat("uz-UZ").format(Number(price) || 0)} so‘m`;
  const formatDate = (date) => new Intl.DateTimeFormat("uz-UZ", { dateStyle: "medium", timeStyle: "short" }).format(new Date(date));
  const makeId = (prefix = "PR") => `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  let products = [];
  let orders = [];
  let settings = { ...DEFAULT_SETTINGS };
  let cart = {};
  let selectedCategory = "Barchasi";
  let locationCoordinates = null;
  let currentAdminView = "overview";
  let adminAuthenticated = false;
  let submittingOrder = false;
  let focusedElementBeforeDialog = null;
  let supabaseSession = null;

  function loadSupabaseSession() {
    try {
      const session = JSON.parse(localStorage.getItem(SUPABASE_SESSION_KEY) || "null");
      supabaseSession = session && typeof session.access_token === "string" ? session : null;
    } catch (error) {
      localStorage.removeItem(SUPABASE_SESSION_KEY);
      supabaseSession = null;
    }
  }

  function saveSupabaseSession(session) {
    supabaseSession = session
      ? { ...session, expires_at: session.expires_at || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600) }
      : null;
    try {
      if (supabaseSession) localStorage.setItem(SUPABASE_SESSION_KEY, JSON.stringify(supabaseSession));
      else localStorage.removeItem(SUPABASE_SESSION_KEY);
    } catch (error) {
      throw new Error(`Kirish sessiyasini saqlab bo‘lmadi: ${error.message}`);
    }
  }

  function supabaseHeaders({ authenticated = false, prefer = "", contentType = true } = {}) {
    const headers = { apikey: SUPABASE_ANON_KEY };
    headers.Authorization = `Bearer ${authenticated && supabaseSession?.access_token ? supabaseSession.access_token : SUPABASE_ANON_KEY}`;
    if (contentType) headers["Content-Type"] = "application/json";
    if (prefer) headers.Prefer = prefer;
    return headers;
  }

  async function supabaseRequest(path, { method = "GET", body, authenticated = false, prefer = "", headers = {}, contentType = true } = {}) {
    if (!SUPABASE_ENABLED) throw new Error("Supabase manzili yoki ommaviy kaliti kiritilmagan.");
    const response = await fetch(`${SUPABASE_URL}${path.startsWith("/auth/") || path.startsWith("/storage/") ? "" : "/rest/v1"}${path}`, {
      method,
      headers: { ...supabaseHeaders({ authenticated, prefer, contentType }), ...headers },
      body
    });
    const text = await response.text();
    let result = null;
    if (text) {
      try { result = JSON.parse(text); }
      catch { result = text; }
    }
    if (!response.ok) {
      const detail = typeof result === "object" && result
        ? result.message || result.msg || result.error_description || result.error
        : result;
      throw new Error(detail || `Server xatosi (${response.status})`);
    }
    return result;
  }

  async function refreshSupabaseSession() {
    if (!supabaseSession?.refresh_token) return false;
    try {
      const refreshed = await supabaseRequest(`/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        body: JSON.stringify({ refresh_token: supabaseSession.refresh_token })
      });
      saveSupabaseSession(refreshed);
      return true;
    } catch {
      saveSupabaseSession(null);
      return false;
    }
  }

  async function loadRemoteProducts() {
    const rows = await supabaseRequest("/products?select=*&order=created_at.desc", { authenticated: adminAuthenticated });
    products = rows.map((row) => ({
      id: row.id,
      title: row.title,
      price: Number(row.price),
      category: row.category,
      image: row.image || "",
      description: row.description,
      available: row.available,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
    renderCatalog();
    renderCategorySuggestions();
  }

  async function loadRemoteSettings() {
    const rows = await supabaseRequest("/store_settings?select=store_name,phone,delivery_info&id=eq.true");
    if (!rows.length) return;
    settings = {
      ...settings,
      storeName: rows[0].store_name,
      phone: rows[0].phone,
      deliveryInfo: rows[0].delivery_info
    };
    applyStoreSettings();
  }

  async function loadRemoteOrders() {
    const rows = await supabaseRequest("/orders?select=*&order=created_at.desc", { authenticated: true });
    orders = rows.map((row) => ({
      id: row.order_number,
      databaseId: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status,
      customer: { name: row.customer_name, phone: row.phone },
      fulfillment: row.fulfillment,
      address: row.address,
      coordinates: row.coordinates,
      mapLink: row.map_link,
      note: row.note,
      items: row.items,
      total: Number(row.total)
    }));
  }

  async function uploadRemoteProductImage(file) {
    if (!file) return "";
    if (!file.type.startsWith("image/")) throw new Error("Faqat rasm faylini yuklang.");
    if (file.size > 4 * 1024 * 1024) throw new Error("Rasm hajmi 4 MB dan kichik bo‘lishi kerak.");
    const safeName = file.name.replace(/[^\w.-]/g, "-");
    const objectPath = `${crypto.randomUUID()}-${safeName}`;
    await supabaseRequest(`/storage/v1/object/product-images/${encodeURIComponent(objectPath)}`, {
      method: "POST",
      body: file,
      authenticated: true,
      contentType: false,
      headers: { "Content-Type": file.type, "x-upsert": "true" }
    });
    return `${SUPABASE_URL}/storage/v1/object/public/product-images/${encodeURIComponent(objectPath)}`;
  }

  async function initializeBackend() {
    if (!SUPABASE_ENABLED) return;
    $("#footer-status-text").textContent = "Supabase server";
    $("#admin-security-note").textContent = "Admin login va parol Supabase Auth orqali tekshiriladi. Maxfiy server kaliti saytga qo‘yilmaydi.";
    $("#admin-mode-text").textContent = "Supabase server";
    $("#checkout-storage-note").innerHTML = "<span>ⓘ</span> Buyurtmangiz serverda saqlanadi va admin panelga kelib tushadi.";
    try {
      await Promise.all([loadRemoteProducts(), loadRemoteSettings()]);
    } catch (error) {
      notify(`Server ma’lumotlarini yuklab bo‘lmadi: ${error.message}`, "error");
    }
    if (supabaseSession) {
      try {
        await supabaseRequest("/auth/v1/user", { authenticated: true, contentType: false });
        const admins = await supabaseRequest(`/admin_users?select=user_id&user_id=eq.${encodeURIComponent(supabaseSession.user?.id || "")}`, { authenticated: true });
        if (admins.length) {
          adminAuthenticated = true;
          await loadRemoteProducts();
          await loadRemoteOrders();
          renderAdminView();
        }
      } catch {
        if (await refreshSupabaseSession()) {
          try {
            const user = await supabaseRequest("/auth/v1/user", { authenticated: true, contentType: false });
            supabaseSession.user = user;
            saveSupabaseSession(supabaseSession);
            const admins = await supabaseRequest(`/admin_users?select=user_id&user_id=eq.${encodeURIComponent(user.id)}`, { authenticated: true });
            if (admins.length) {
              adminAuthenticated = true;
              await loadRemoteProducts();
              await loadRemoteOrders();
              renderAdminView();
            }
          } catch {
            saveSupabaseSession(null);
          }
        } else {
          saveSupabaseSession(null);
        }
      }
    }
  }

  function readStored(key, fallback, validator) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      const parsed = JSON.parse(raw);
      if (!validator(parsed)) throw new Error("Saqlangan ma’lumot formati noto‘g‘ri.");
      return parsed;
    } catch (error) {
      notify(`Saqlangan ma’lumotni o‘qib bo‘lmadi: ${error.message}`, "error");
      return fallback;
    }
  }

  function persist(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      notify(`Brauzer xotirasiga saqlab bo‘lmadi: ${error.message}`, "error");
      return false;
    }
  }

  function notify(message, type = "success") {
    const region = $("#toast-region");
    if (!region) return;
    const toast = document.createElement("div");
    toast.className = `toast${type === "error" ? " error" : ""}`;
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    toast.textContent = message;
    region.append(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }

  function openDialog(dialog) {
    if (!dialog || dialog.open) return;
    focusedElementBeforeDialog = document.activeElement;
    dialog.showModal();
    document.body.classList.add("modal-open");
  }

  function closeDialog(dialog) {
    if (!dialog?.open) return;
    dialog.close();
    if (!$$("dialog[open]").length) document.body.classList.remove("modal-open");
    if (focusedElementBeforeDialog instanceof HTMLElement) focusedElementBeforeDialog.focus();
  }

  function loadState() {
    products = SUPABASE_ENABLED ? [] : readStored(KEYS.products, [], Array.isArray);
    orders = SUPABASE_ENABLED ? [] : readStored(KEYS.orders, [], Array.isArray);
    const storedSettings = readStored(KEYS.settings, DEFAULT_SETTINGS, (value) => value && typeof value === "object" && !Array.isArray(value));
    settings = { ...DEFAULT_SETTINGS, ...storedSettings };
    applyStoreSettings();
    $("#current-year").textContent = String(new Date().getFullYear());
    renderCatalog();
    renderCartCount();
    renderCategorySuggestions();
  }

  function applyStoreSettings() {
    document.title = `${settings.storeName} — Aqlli tanlov`;
    const metaTitle = $('meta[property="og:title"]');
    if (metaTitle) metaTitle.content = settings.storeName;
    const brandParts = settings.storeName.split("|").map((part) => part.trim()).filter(Boolean);
    $$(".brand-copy").forEach((brand) => {
      brand.querySelector("strong").textContent = brandParts[0] || "SHARK";
      brand.querySelector("small").textContent = brandParts.slice(1).join(" | ") || "SHOP";
    });
    const digits = settings.phone.replace(/\D/g, "");
    const phone = digits.startsWith("998") ? `+${digits}` : `+998${digits}`;
    const displayPhone = /^\+998\d{9}$/.test(phone)
      ? `${phone.slice(0, 4)} ${phone.slice(4, 6)} ${phone.slice(6, 9)} ${phone.slice(9, 11)} ${phone.slice(11)}`
      : settings.phone;
    $$('a[href^="tel:"]').forEach((link) => {
      link.href = `tel:${phone}`;
      link.textContent = displayPhone;
    });
    $("#delivery-help").textContent = settings.deliveryInfo;
  }

  function safeImage(product, className = "product-image") {
    if (!product.image) return `<div class="product-placeholder" aria-hidden="true">◈</div>`;
    return `<img class="${className}" src="${escapeHtml(product.image)}" alt="${escapeHtml(product.title)}" loading="lazy" decoding="async">`;
  }

  function getFilteredProducts() {
    const query = $("#product-search").value.trim().toLocaleLowerCase("uz");
    return products.filter((product) => {
      const matchesCategory = selectedCategory === "Barchasi" || product.category === selectedCategory;
      const searchText = `${product.title} ${product.description} ${product.category}`.toLocaleLowerCase("uz");
      return matchesCategory && (!query || searchText.includes(query));
    });
  }

  function renderCategoryFilter() {
    const categories = ["Barchasi", ...new Set(products.map((product) => product.category).filter(Boolean))];
    if (!categories.includes(selectedCategory)) selectedCategory = "Barchasi";
    $("#category-filter").innerHTML = categories.map((category) =>
      `<button class="filter-chip${category === selectedCategory ? " active" : ""}" type="button" data-category="${escapeHtml(category)}" aria-pressed="${category === selectedCategory}">${escapeHtml(category)}</button>`
    ).join("");
  }

  function renderCatalog() {
    renderCategoryFilter();
    const shown = getFilteredProducts();
    $("#catalog-count").textContent = `${shown.length} ta mahsulot`;
    const grid = $("#product-grid");
    grid.innerHTML = shown.map((product) => `
      <article class="product-card">
        <div class="product-image-wrap">
          ${safeImage(product)}
          <span class="product-category">${escapeHtml(product.category)}</span>
          ${product.available ? "" : '<span class="product-category product-unavailable">Sotuvda yo‘q</span>'}
        </div>
        <div class="product-card-body">
          <h3 title="${escapeHtml(product.title)}">${escapeHtml(product.title)}</h3>
          <p class="product-description">${escapeHtml(product.description)}</p>
          <div class="product-card-footer">
            <div class="product-price">${formatPrice(product.price)}<small>QQS va yetkazib berish kelishiladi</small></div>
            <div class="product-actions">
              <button type="button" class="product-details" data-product-details="${escapeHtml(product.id)}">Batafsil</button>
              <button type="button" class="product-buy" data-add-cart="${escapeHtml(product.id)}" ${product.available ? "" : "disabled"}>Savatga</button>
            </div>
          </div>
        </div>
      </article>`).join("");
    const noProducts = products.length === 0;
    $("#empty-state").hidden = !noProducts;
    grid.hidden = noProducts || shown.length === 0;
    if (!noProducts && shown.length === 0) {
      grid.hidden = false;
      grid.innerHTML = `<div class="admin-empty" style="grid-column:1/-1">Qidiruv bo‘yicha mahsulot topilmadi.</div>`;
    }
  }

  function renderCartCount() {
    $("#cart-count").textContent = String(Object.values(cart).reduce((sum, quantity) => sum + quantity, 0));
  }

  function cartProducts() {
    return Object.entries(cart).map(([id, quantity]) => {
      const product = products.find((item) => item.id === id);
      return product ? { ...product, quantity } : null;
    }).filter(Boolean);
  }

  function cartTotal() {
    return cartProducts().reduce((sum, product) => sum + Number(product.price) * product.quantity, 0);
  }

  function renderCart() {
    const content = $("#cart-content");
    const items = cartProducts();
    if (items.length === 0) {
      content.innerHTML = `<div class="cart-empty"><div class="cart-empty-icon">◇</div><h3>Savatchangiz hozircha bo‘sh</h3><p>Katalogdan mahsulot tanlab savatga qo‘shing.</p><button class="button button-secondary" type="button" data-close-dialog>Mahsulotlarni ko‘rish</button></div>`;
      return;
    }
    content.innerHTML = `
      <div class="cart-list">${items.map((product) => `
        <div class="cart-item">
          ${product.image ? `<img class="cart-thumb" src="${escapeHtml(product.image)}" alt="" loading="lazy">` : '<div class="cart-thumb product-placeholder">◈</div>'}
          <div><h3>${escapeHtml(product.title)}</h3><span class="cart-item-price">${formatPrice(product.price)}</span>
            <div class="cart-qty"><button type="button" data-cart-change="${escapeHtml(product.id)}" data-delta="-1" aria-label="Kamaytirish">−</button><span>${product.quantity}</span><button type="button" data-cart-change="${escapeHtml(product.id)}" data-delta="1" aria-label="Ko‘paytirish">+</button></div>
          </div>
          <button type="button" class="cart-remove" data-cart-remove="${escapeHtml(product.id)}" aria-label="Savatdan o‘chirish">×</button>
        </div>`).join("")}</div>
      <div class="cart-totals"><span>Jami summa</span><strong>${formatPrice(cartTotal())}</strong></div>
      <button class="button button-primary cart-checkout" type="button" id="start-checkout">Buyurtma berish <span>↗</span></button>`;
  }

  function addToCart(id) {
    const product = products.find((item) => item.id === id);
    if (!product || !product.available) {
      notify("Bu mahsulot hozir sotuvda mavjud emas.", "error");
      return;
    }
    cart[id] = (cart[id] || 0) + 1;
    renderCartCount();
    notify("Mahsulot savatga qo‘shildi.");
  }

  function changeCartQuantity(id, delta) {
    const next = (cart[id] || 0) + delta;
    if (next <= 0) delete cart[id];
    else cart[id] = next;
    renderCartCount();
    renderCart();
  }

  function showProduct(id) {
    const product = products.find((item) => item.id === id);
    if (!product) return;
    $("#product-modal-content").innerHTML = `
      <div class="product-detail-layout">
        <div class="product-detail-image">${product.image ? `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.title)}">` : '<span>◈</span>'}</div>
        <div class="product-detail-info"><p class="eyebrow">${escapeHtml(product.category)}</p><h2 id="product-modal-title">${escapeHtml(product.title)}</h2>
        <p>${escapeHtml(product.description)}</p><strong>${formatPrice(product.price)}</strong>
        <button class="button button-primary" type="button" data-add-cart="${escapeHtml(product.id)}" ${product.available ? "" : "disabled"}>Savatga qo‘shish <span>↗</span></button></div>
      </div>`;
    openDialog($("#product-modal"));
  }

  function renderCategorySuggestions() {
    $("#category-suggestions").innerHTML = [...new Set(products.map((item) => item.category).filter(Boolean))]
      .map((category) => `<option value="${escapeHtml(category)}"></option>`).join("");
  }

  function toggleFulfillment() {
    const method = $('input[name="fulfillment"]:checked')?.value || "delivery";
    const pickup = method === "pickup";
    $$(".fulfillment-option").forEach((label) => label.classList.toggle("selected", label.querySelector("input").checked));
    $$(".delivery-field").forEach((field) => { field.hidden = pickup; });
    $("#delivery-address").required = !pickup;
    $("#pickup-info").hidden = !pickup;
  }

  function renderCheckoutSummary() {
    const total = cartTotal();
    const count = Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
    $("#checkout-summary").innerHTML = `<span>Buyurtma · ${count} dona</span><strong>${formatPrice(total)}</strong>`;
  }

  async function getCurrentLocation() {
    const status = $("#location-status");
    if (!navigator.geolocation) {
      status.textContent = "Brauzeringiz GPS’ni qo‘llamaydi";
      notify("Bu brauzer joylashuvni aniqlashni qo‘llab-quvvatlamaydi.", "error");
      return;
    }
    const button = $("#get-location");
    button.disabled = true;
    status.textContent = "Joylashuv aniqlanmoqda...";
    navigator.geolocation.getCurrentPosition((position) => {
      locationCoordinates = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      status.textContent = "Joylashuv aniqlandi ✓";
      button.disabled = false;
      notify("Joylashuvingiz buyurtmaga qo‘shildi.");
    }, (error) => {
      locationCoordinates = null;
      status.textContent = error.code === error.PERMISSION_DENIED ? "Ruxsat berilmadi" : "Aniqlab bo‘lmadi";
      button.disabled = false;
      notify(`Joylashuv aniqlanmadi: ${error.message}`, "error");
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }

  function isValidUzbekPhone(value) {
    const digits = value.replace(/\D/g, "");
    return /^(998)?\d{9}$/.test(digits);
  }

  function makeOrderPayload(formData) {
    const method = formData.get("fulfillment");
    const name = String(formData.get("name") || "").trim();
    const phone = String(formData.get("phone") || "").trim();
    const address = method === "delivery" ? String(formData.get("address") || "").trim() : "";
    const mapLink = locationCoordinates
      ? `https://www.google.com/maps?q=${locationCoordinates.latitude},${locationCoordinates.longitude}`
      : "";
    return {
      id: makeId("SH"),
      createdAt: new Date().toISOString(),
      status: "Yangi",
      customer: { name, phone },
      fulfillment: method === "delivery" ? "Yetkazib berish" : "Olib ketish",
      address,
      coordinates: method === "delivery" ? locationCoordinates : null,
      mapLink: method === "delivery" ? mapLink : "",
      note: String(formData.get("note") || "").trim(),
      items: cartProducts().map(({ id, title, price, quantity }) => ({ productId: id, title, price: Number(price), quantity })),
      total: cartTotal()
    };
  }

  async function submitOrder(event) {
    event.preventDefault();
    if (submittingOrder) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const phone = String(formData.get("phone") || "").trim();
    if (!form.reportValidity()) return;
    if (!isValidUzbekPhone(phone)) {
      notify("Telefon raqamini to‘g‘ri kiriting. Masalan: +998 90 123 45 67", "error");
      form.elements.phone.focus();
      return;
    }
    if (cartProducts().length === 0) {
      notify("Savatchada buyurtma berish uchun mahsulot yo‘q.", "error");
      closeDialog($("#checkout-modal"));
      return;
    }
    const order = makeOrderPayload(formData);
    submittingOrder = true;
    const submitButton = form.querySelector('[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = "Yuborilmoqda...";
    try {
      if (SUPABASE_ENABLED) {
        const savedOrder = await supabaseRequest("/rpc/place_shark_order", {
          method: "POST",
          body: JSON.stringify({
            p_customer_name: order.customer.name,
            p_phone: order.customer.phone,
            p_fulfillment: order.fulfillment,
            p_address: order.address,
            p_coordinates: order.coordinates,
            p_note: order.note,
            p_items: Object.entries(cart).map(([productId, quantity]) => ({ productId, quantity }))
          })
        });
        order.id = savedOrder.orderNumber;
        order.databaseId = savedOrder.id;
        order.createdAt = savedOrder.createdAt;
        order.status = savedOrder.status;
        order.total = Number(savedOrder.total);
        order.items = savedOrder.items;
      } else if (API_BASE) {
        const response = await fetch(`${API_BASE}/api/orders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(order)
        });
        if (!response.ok) {
          const reason = await response.text();
          throw new Error(reason || `Server xatosi (${response.status})`);
        }
      } else {
        const updatedOrders = [order, ...orders];
        if (!persist(KEYS.orders, updatedOrders)) throw new Error("Buyurtma brauzer xotirasiga yozilmadi.");
        orders = updatedOrders;
      }
      closeDialog($("#checkout-modal"));
      cart = {};
      locationCoordinates = null;
      form.reset();
      toggleFulfillment();
      renderCartCount();
      showOrderConfirmation(order);
      if (SUPABASE_ENABLED && adminAuthenticated) {
        await loadRemoteOrders();
        renderAdminView();
      } else if (adminAuthenticated) {
        renderAdminView();
      }
    } catch (error) {
      notify(`Buyurtma yuborilmadi: ${error.message}`, "error");
    } finally {
      submittingOrder = false;
      submitButton.disabled = false;
      submitButton.innerHTML = 'Buyurtmani tasdiqlash <span aria-hidden="true">↗</span>';
    }
  }

  function showOrderConfirmation(order) {
    const dialog = $("#cart-modal");
    $("#cart-title").textContent = "Buyurtma qabul qilindi";
    $("#cart-content").innerHTML = `
      <div class="cart-empty order-success">
        <div class="order-success-mark">✓</div><p class="eyebrow">SHARK SHOP · ${SUPABASE_ENABLED || API_BASE ? "SERVER" : "MAHALLIY"}</p>
        <h3>Buyurtmangiz qabul qilindi!</h3>
        <p>Buyurtma raqami: <strong>${escapeHtml(order.id)}</strong><br>${escapeHtml(order.customer.name)}, siz bilan telefon orqali bog‘lanamiz.</p>
        <div class="order-confirm-summary"><span>${escapeHtml(order.fulfillment)}</span><b>${formatPrice(order.total)}</b><small>${formatDate(order.createdAt)}</small></div>
        ${SUPABASE_ENABLED || API_BASE ? "" : '<p class="local-storage-warning">Buyurtma shu brauzerda saqlandi. Barcha mijozlarning buyurtmalarini bir joyda ko‘rish uchun server ulash kerak.</p>'}
        <button class="button button-secondary" type="button" data-close-dialog>Yopish</button>
      </div>`;
    openDialog(dialog);
  }

  async function readProductImage(file) {
    if (!file) return "";
    if (!file.type.startsWith("image/")) throw new Error("Faqat rasm faylini yuklang.");
    if (file.size > 4 * 1024 * 1024) throw new Error("Rasm hajmi 4 MB dan kichik bo‘lishi kerak.");
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Rasm faylini o‘qib bo‘lmadi."));
      reader.readAsDataURL(file);
    });
  }

  function beginProductEdit(id = "") {
    const form = $("#product-form");
    form.reset();
    $("#product-form-error").textContent = "";
    form.elements.id.value = id;
    const product = products.find((item) => item.id === id);
    $("#product-form-title").innerHTML = product ? "Mahsulotni tahrirlash<span>.</span>" : "Mahsulot qo‘shish<span>.</span>";
    if (product) {
      form.elements.title.value = product.title;
      form.elements.price.value = product.price;
      form.elements.category.value = product.category;
      form.elements.imageUrl.value = product.image && !product.image.startsWith("data:") ? product.image : "";
      form.elements.description.value = product.description;
      form.elements.available.checked = product.available;
    } else {
      form.elements.available.checked = true;
    }
    openDialog($("#product-form-modal"));
  }

  async function saveProduct(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const errorEl = $("#product-form-error");
    errorEl.textContent = "";
    if (!form.reportValidity()) return;
    const oldProduct = products.find((item) => item.id === form.elements.id.value);
    try {
      const selectedFile = form.elements.image.files[0];
      const uploadedImage = SUPABASE_ENABLED
        ? await uploadRemoteProductImage(selectedFile)
        : await readProductImage(selectedFile);
      const product = {
        id: oldProduct?.id || makeId(),
        title: form.elements.title.value.trim(),
        price: Number(form.elements.price.value),
        category: form.elements.category.value.trim(),
        image: uploadedImage || form.elements.imageUrl.value.trim() || oldProduct?.image || "",
        description: form.elements.description.value.trim(),
        available: form.elements.available.checked,
        updatedAt: new Date().toISOString(),
        createdAt: oldProduct?.createdAt || new Date().toISOString()
      };
      if (!Number.isFinite(product.price) || product.price < 1) throw new Error("Narx 0 dan katta bo‘lishi kerak.");
      if (SUPABASE_ENABLED) {
        const payload = {
          title: product.title,
          price: product.price,
          category: product.category,
          image: product.image,
          description: product.description,
          available: product.available,
          updated_at: new Date().toISOString()
        };
        if (oldProduct) {
          await supabaseRequest(`/products?id=eq.${encodeURIComponent(oldProduct.id)}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
            authenticated: true
          });
        } else {
          delete payload.updated_at;
          await supabaseRequest("/products", {
            method: "POST",
            body: JSON.stringify(payload),
            authenticated: true,
            prefer: "return=minimal"
          });
        }
        await loadRemoteProducts();
        closeDialog($("#product-form-modal"));
        renderAdminView();
        notify(oldProduct ? "Mahsulot yangilandi." : "Mahsulot katalogga qo‘shildi.");
        return;
      }
      const updated = oldProduct
        ? products.map((item) => item.id === oldProduct.id ? product : item)
        : [product, ...products];
      if (!persist(KEYS.products, updated)) return;
      products = updated;
      closeDialog($("#product-form-modal"));
      renderCatalog();
      renderCategorySuggestions();
      renderAdminView();
      notify(oldProduct ? "Mahsulot yangilandi." : "Mahsulot katalogga qo‘shildi.");
    } catch (error) {
      errorEl.textContent = error.message;
    }
  }

  function deleteProduct(id) {
    const product = products.find((item) => item.id === id);
    if (!product || !window.confirm(`"${product.title}" mahsulotini o‘chirmoqchimisiz?`)) return;
    if (SUPABASE_ENABLED) {
      void (async () => {
        try {
          await supabaseRequest(`/products?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", authenticated: true });
          await loadRemoteProducts();
          renderAdminView();
          notify("Mahsulot o‘chirildi.");
        } catch (error) {
          notify(`Mahsulotni o‘chirib bo‘lmadi: ${error.message}`, "error");
        }
      })();
      return;
    }
    const updated = products.filter((item) => item.id !== id);
    if (!persist(KEYS.products, updated)) return;
    products = updated;
    delete cart[id];
    renderCatalog();
    renderCartCount();
    renderCategorySuggestions();
    renderAdminView();
    notify("Mahsulot o‘chirildi.");
  }

  async function authenticateAdmin(username, password) {
    if (SUPABASE_ENABLED) {
      const session = await supabaseRequest("/auth/v1/token?grant_type=password", {
        method: "POST",
        body: JSON.stringify({ email: username, password })
      });
      saveSupabaseSession(session);
      const admins = await supabaseRequest(`/admin_users?select=user_id&user_id=eq.${encodeURIComponent(session.user.id)}`, { authenticated: true });
      if (!admins.length) {
        saveSupabaseSession(null);
        return false;
      }
      return true;
    }
    if (API_BASE) {
      const response = await fetch(`${API_BASE}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password })
      });
      if (!response.ok) return false;
      const result = await response.json();
      return result.authenticated === true;
    }
    return username === settings.username && password === settings.password;
  }

  function hasAdminCredentials() {
    return Boolean(SUPABASE_ENABLED || API_BASE || (settings.username && settings.password));
  }

  function updateAdminLoginMode() {
    const setupMode = !SUPABASE_ENABLED && !hasAdminCredentials();
    const form = $("#admin-login-form");
    const confirmField = $("#confirm-password-field");
    $("#admin-login-title").innerHTML = setupMode ? "Admin hisobini yarating<span>.</span>" : "Admin panel<span>.</span>";
    $("#admin-login-subtitle").textContent = SUPABASE_ENABLED
      ? "Supabase admin hisobingiz email va parolini kiriting."
      : setupMode ? "Admin login va parolingizni o‘zingiz belgilang." : "Davom etish uchun admin hisobiga kiring.";
    $("#admin-login-submit").innerHTML = setupMode
      ? 'Hisob yaratish <span aria-hidden="true">↗</span>'
      : 'Kirish <span aria-hidden="true">↗</span>';
    $("#admin-username-label").textContent = SUPABASE_ENABLED ? "Admin email" : "Login";
    form.elements.username.type = SUPABASE_ENABLED ? "email" : "text";
    form.elements.username.placeholder = SUPABASE_ENABLED ? "admin@example.com" : "Login";
    confirmField.hidden = !setupMode;
    form.elements.confirmPassword.required = setupMode;
    form.elements.password.minLength = setupMode ? 10 : 0;
    form.elements.password.autocomplete = setupMode ? "new-password" : "current-password";
  }

  async function handleAdminLogin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    const error = $("#login-error");
    error.textContent = "";
    button.disabled = true;
    try {
      if (!API_BASE && !hasAdminCredentials()) {
        const username = form.elements.username.value.trim();
        const password = form.elements.password.value;
        if (password.length < 10) {
          error.textContent = "Parol kamida 10 ta belgidan iborat bo‘lsin.";
          return;
        }
        if (password !== form.elements.confirmPassword.value) {
          error.textContent = "Kiritilgan parollar mos kelmadi.";
          return;
        }
        const updatedSettings = { ...settings, username, password };
        if (!persist(KEYS.settings, updatedSettings)) return;
        settings = updatedSettings;
        adminAuthenticated = true;
        form.reset();
        updateAdminLoginMode();
        closeDialog($("#admin-login-modal"));
        openAdminDashboard("overview");
        notify("Admin hisobi yaratildi.");
        return;
      }
      const ok = await authenticateAdmin(form.elements.username.value.trim(), form.elements.password.value);
      if (!ok) {
        error.textContent = SUPABASE_ENABLED ? "Email/parol noto‘g‘ri yoki bu foydalanuvchiga admin ruxsati berilmagan." : "Login yoki parol noto‘g‘ri.";
        return;
      }
      adminAuthenticated = true;
      if (SUPABASE_ENABLED) {
        await loadRemoteProducts();
        await loadRemoteOrders();
      }
      form.reset();
      closeDialog($("#admin-login-modal"));
      openAdminDashboard("overview");
    } catch (requestError) {
      error.textContent = SUPABASE_ENABLED || API_BASE ? `Serverga ulanib bo‘lmadi: ${requestError.message}` : requestError.message;
    } finally {
      button.disabled = false;
    }
  }

  function requireAdmin() {
    if (!adminAuthenticated) {
      notify("Admin panel uchun avval tizimga kiring.", "error");
      openDialog($("#admin-login-modal"));
      return false;
    }
    return true;
  }

  function openAdminDashboard(view = "overview") {
    if (!requireAdmin()) return;
    currentAdminView = view;
    renderAdminView();
    openDialog($("#admin-modal"));
  }

  function setAdminView(view) {
    if (!requireAdmin()) return;
    currentAdminView = view;
    $$(".admin-nav-item").forEach((button) => button.classList.toggle("active", button.dataset.adminView === view));
    renderAdminView();
  }

  function statusClass(status) {
    if (["Yetkazildi", "Tasdiqlandi"].includes(status)) return "";
    if (status === "Bekor qilindi") return "status-muted";
    if (status === "Yangi") return "status-warn";
    return "";
  }

  function renderOverview() {
    const newOrders = orders.filter((order) => order.status === "Yangi").length;
    const confirmed = orders.filter((order) => order.status === "Tasdiqlandi").length;
    const delivered = orders.filter((order) => order.status === "Yetkazildi").length;
    const sales = orders.filter((order) => order.status !== "Bekor qilindi").reduce((sum, order) => sum + Number(order.total || 0), 0);
    const recent = orders.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
    return `
      <div class="stats-grid">
        <div class="stat-card"><span class="stat-symbol">▤</span><small>Jami mahsulotlar</small><strong>${products.length}</strong></div>
        <div class="stat-card"><span class="stat-symbol">▣</span><small>Jami buyurtmalar</small><strong>${orders.length}</strong></div>
        <div class="stat-card"><span class="stat-symbol">◷</span><small>Yangi buyurtmalar</small><strong>${newOrders}</strong></div>
        <div class="stat-card"><span class="stat-symbol">✓</span><small>Tasdiqlangan / yetkazilgan</small><strong>${confirmed} / ${delivered}</strong></div>
        <div class="stat-card"><span class="stat-symbol">↗</span><small>Buyurtmalar jami</small><strong style="font-size:14px">${formatPrice(sales)}</strong></div>
      </div>
      <div class="admin-panel-card">
        <div class="admin-panel-heading"><div><h3>So‘nggi buyurtmalar</h3><p>Eng oxirgi kelib tushgan buyurtmalar</p></div><button class="admin-mini-button" data-go-admin="orders">Barchasini ko‘rish →</button></div>
        ${recent.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>BUYURTMA</th><th>MIJOZ</th><th>JAMI</th><th>HOLATI</th><th>VAQT</th></tr></thead><tbody>${recent.map((order) => `<tr><td>#${escapeHtml(order.id)}</td><td>${escapeHtml(order.customer?.name)}</td><td>${formatPrice(order.total)}</td><td><span class="status-pill ${statusClass(order.status)}">${escapeHtml(order.status)}</span></td><td>${formatDate(order.createdAt)}</td></tr>`).join("")}</tbody></table></div>` : '<div class="admin-empty">Hozircha buyurtmalar yo‘q. Buyurtmalar mijozlar rasmiylashtirganda shu yerda ko‘rinadi.</div>'}
      </div>
      <div class="admin-panel-card admin-quick-actions" style="margin-top:12px"><div class="admin-panel-heading"><div><h3>Tezkor amallar</h3><p>Katalogingizni boshqaring</p></div></div><button class="admin-mini-button" data-admin-product-add>＋ Mahsulot qo‘shish</button></div>`;
  }

  function renderAdminProducts() {
    return `<div class="admin-panel-card"><div class="admin-panel-heading"><div><h3>Mahsulotlar</h3><p>${products.length} ta mahsulot · ${SUPABASE_ENABLED ? "Serverda saqlanadi" : "Brauzerda saqlanadi"}</p></div><button class="admin-mini-button" data-admin-product-add>＋ Yangi mahsulot</button></div>
      ${products.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>MAHSULOT</th><th>KATEGORIYA</th><th>NARX</th><th>HOLATI</th><th>AMALLAR</th></tr></thead><tbody>${products.map((product) => `<tr><td><div class="admin-product-name">${product.image ? `<img src="${escapeHtml(product.image)}" alt="" loading="lazy">` : '<span class="admin-product-placeholder">◈</span>'}<span>${escapeHtml(product.title)}</span></div></td><td>${escapeHtml(product.category)}</td><td>${formatPrice(product.price)}</td><td><span class="status-pill ${product.available ? "" : "status-muted"}">${product.available ? "Sotuvda" : "Yashirilgan"}</span></td><td><div class="product-admin-actions"><button class="table-action" data-edit-product="${escapeHtml(product.id)}">Tahrirlash</button><button class="table-action delete" data-delete-product="${escapeHtml(product.id)}">O‘chirish</button></div></td></tr>`).join("")}</tbody></table></div>` : '<div class="admin-empty">Katalog bo‘sh. Birinchi mahsulotni qo‘shish uchun yuqoridagi tugmani bosing.</div>'}
      </div>`;
  }

  function renderAdminOrders() {
    const q = ($("#admin-order-search")?.value || "").trim().toLocaleLowerCase("uz");
    const filtered = orders.filter((order) => `${order.id} ${order.customer?.name} ${order.customer?.phone}`.toLocaleLowerCase("uz").includes(q))
      .slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return `<div class="admin-panel-card"><div class="admin-panel-heading"><div><h3>Buyurtmalar</h3><p>${orders.length} ta buyurtma · ${SUPABASE_ENABLED || API_BASE ? "Server" : "Faqat ushbu brauzer"}</p></div></div>
      <div class="admin-toolbar"><label class="search-box admin-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></svg><input id="admin-order-search" type="search" value="${escapeHtml(q)}" placeholder="Ism, telefon yoki ID..." aria-label="Buyurtma qidirish"></label><span class="catalog-count">${filtered.length} ta</span></div>
      ${filtered.length ? filtered.map((order) => `<article class="admin-order-card">
        <div class="admin-order-top"><div><h4>#${escapeHtml(order.id)} · ${escapeHtml(order.customer?.name)}</h4><p>${formatDate(order.createdAt)}</p></div><span class="status-pill ${statusClass(order.status)}">${escapeHtml(order.status)}</span></div>
        <div class="admin-order-info"><span>☎ ${escapeHtml(order.customer?.phone)}</span><span>🚚 ${escapeHtml(order.fulfillment)}</span><span class="admin-order-items">Mahsulotlar: ${order.items.map((item) => `${escapeHtml(item.title)} × ${item.quantity}`).join(", ")}</span>${order.address ? `<span>⌖ ${escapeHtml(order.address)}</span>` : ""}${order.mapLink ? `<a href="${escapeHtml(order.mapLink)}" target="_blank" rel="noopener noreferrer">Google Maps joylashuv ↗</a>` : ""}${order.note ? `<span>Izoh: ${escapeHtml(order.note)}</span>` : ""}</div>
        <div class="admin-order-bottom"><strong>${formatPrice(order.total)}</strong><div><a href="tel:${escapeHtml(order.customer?.phone?.replace(/[^+\d]/g, "") || "")}">Qo‘ng‘iroq</a> <select class="admin-select" data-order-status="${escapeHtml(order.id)}" aria-label="Buyurtma holatini o‘zgartirish">${ORDER_STATUSES.map((status) => `<option ${status === order.status ? "selected" : ""}>${status}</option>`).join("")}</select></div></div>
      </article>`).join("") : '<div class="admin-empty">Buyurtmalar topilmadi.</div>'}
      </div>`;
  }

  function renderAdminSettings() {
    const accountFields = SUPABASE_ENABLED ? "" : `
        <label class="field"><span>Admin logini</span><input name="username" required value="${escapeHtml(settings.username)}" autocomplete="username"></label>
        <label class="field"><span>Yangi admin paroli</span><input name="password" type="password" minlength="10" placeholder="O‘zgartirmaslik uchun bo‘sh qoldiring" autocomplete="new-password"></label>`;
    const securityNotice = SUPABASE_ENABLED
      ? "Do‘kon ma’lumotlari Supabase’da saqlanadi. Admin hisobini Supabase Auth bo‘limida boshqarasiz."
      : "Login va parol ushbu brauzerda saqlanadi. Frontenddagi parol haqiqiy himoya bermaydi; ommaviy do‘kon uchun server autentifikatsiyasi va API kerak.";
    return `<div class="settings-notice">${securityNotice}</div>
      <div class="admin-panel-card admin-form-grid"><div class="admin-panel-heading"><div><h3>Do‘kon sozlamalari</h3><p>Do‘kon ma’lumotlari va admin hisobi</p></div></div>
      <form id="settings-form">
        <label class="field"><span>Do‘kon nomi</span><input name="storeName" required value="${escapeHtml(settings.storeName)}"></label>
        <label class="field"><span>Do‘kon telefoni</span><input name="phone" required value="${escapeHtml(settings.phone)}"></label>
        <label class="field"><span>Yetkazib berish haqida ma’lumot</span><textarea name="deliveryInfo" rows="3">${escapeHtml(settings.deliveryInfo)}</textarea></label>
        ${accountFields}
        <button class="button button-primary" type="submit">Sozlamalarni saqlash <span>↗</span></button>
      </form></div>`;
  }

  function renderAdminView() {
    if (!adminAuthenticated) return;
    const titles = { overview: "Umumiy ko‘rinish", products: "Mahsulotlar", orders: "Buyurtmalar", settings: "Sozlamalar" };
    $("#admin-heading").textContent = titles[currentAdminView] || titles.overview;
    $("#admin-date").textContent = new Intl.DateTimeFormat("uz-UZ", { dateStyle: "full" }).format(new Date());
    $("#new-order-count").textContent = String(orders.filter((order) => order.status === "Yangi").length);
    $$(".admin-nav-item").forEach((button) => button.classList.toggle("active", button.dataset.adminView === currentAdminView));
    const view = $("#admin-view-content");
    view.innerHTML = currentAdminView === "products" ? renderAdminProducts()
      : currentAdminView === "orders" ? renderAdminOrders()
        : currentAdminView === "settings" ? renderAdminSettings() : renderOverview();
  }

  function updateOrderStatus(id, status) {
    if (SUPABASE_ENABLED) {
      const order = orders.find((item) => item.id === id);
      if (!order) return;
      void (async () => {
        try {
          await supabaseRequest(`/orders?id=eq.${encodeURIComponent(order.databaseId)}`, {
            method: "PATCH",
            body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
            authenticated: true
          });
          await loadRemoteOrders();
          renderAdminView();
          notify("Buyurtma holati yangilandi.");
        } catch (error) {
          notify(`Buyurtma holatini yangilab bo‘lmadi: ${error.message}`, "error");
        }
      })();
      return;
    }
    const updated = orders.map((order) => order.id === id ? { ...order, status, updatedAt: new Date().toISOString() } : order);
    if (!persist(KEYS.orders, updated)) return;
    orders = updated;
    renderAdminView();
    notify("Buyurtma holati yangilandi.");
  }

  async function saveSettings(event) {
    event.preventDefault();
    const form = event.target;
    if (!form.reportValidity()) return;
    if (SUPABASE_ENABLED) {
      try {
        await supabaseRequest("/store_settings?id=eq.true", {
          method: "PATCH",
          authenticated: true,
          body: JSON.stringify({
            store_name: form.elements.storeName.value.trim(),
            phone: form.elements.phone.value.trim(),
            delivery_info: form.elements.deliveryInfo.value.trim(),
            updated_at: new Date().toISOString()
          })
        });
        await loadRemoteSettings();
        renderAdminView();
        notify("Do‘kon sozlamalari serverga saqlandi.");
      } catch (error) {
        notify(`Sozlamalarni saqlab bo‘lmadi: ${error.message}`, "error");
      }
      return;
    }
    const newPassword = form.elements.password.value;
    if (newPassword && newPassword.length < 10) {
      notify("Yangi parol kamida 10 ta belgidan iborat bo‘lsin.", "error");
      form.elements.password.focus();
      return;
    }
    const updated = {
      storeName: form.elements.storeName.value.trim(),
      phone: form.elements.phone.value.trim(),
      deliveryInfo: form.elements.deliveryInfo.value.trim(),
      username: form.elements.username.value.trim(),
      password: newPassword || settings.password
    };
    if (!persist(KEYS.settings, updated)) return;
    settings = updated;
    applyStoreSettings();
    notify("Sozlamalar saqlandi.");
  }

  function syncFromOtherTab(event) {
    if (!Object.values(KEYS).includes(event.key)) return;
    if (event.key === KEYS.products) {
      products = readStored(KEYS.products, [], Array.isArray);
      cart = Object.fromEntries(Object.entries(cart).filter(([id]) => products.some((product) => product.id === id)));
      renderCatalog();
      renderCartCount();
      renderCategorySuggestions();
    } else if (event.key === KEYS.orders) {
      orders = readStored(KEYS.orders, [], Array.isArray);
    } else if (event.key === KEYS.settings) {
      const storedSettings = readStored(KEYS.settings, DEFAULT_SETTINGS, (value) => value && typeof value === "object" && !Array.isArray(value));
      settings = { ...DEFAULT_SETTINGS, ...storedSettings };
      applyStoreSettings();
    }
    if (adminAuthenticated) renderAdminView();
  }

  function addCanvasAnimation() {
    const canvas = $("#ocean-canvas");
    const context = canvas.getContext("2d");
    if (!context) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const particles = [];
    const sharks = [];
    let width = 0;
    let height = 0;
    let frame = 0;
    let animationId = 0;
    const random = (min, max) => min + Math.random() * (max - min);

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const particleCount = Math.min(42, Math.floor(width / 30));
      particles.length = 0;
      for (let i = 0; i < particleCount; i += 1) {
        particles.push({ x: random(0, width), y: random(0, height), radius: random(.5, 1.8), speed: random(.12, .42), alpha: random(.12, .45) });
      }
      sharks.length = 0;
      for (let i = 0; i < 3; i += 1) {
        sharks.push({ x: random(0, width), y: random(height * .15, height * .88), size: random(.35, .8), speed: random(.12, .31), alpha: random(.07, .16), flip: Math.random() > .5 ? 1 : -1 });
      }
    }

    function drawShark(shark) {
      const direction = shark.flip;
      context.save();
      context.translate(shark.x, shark.y);
      context.scale(direction * shark.size, shark.size);
      context.fillStyle = `rgba(92, 176, 205, ${shark.alpha})`;
      context.beginPath();
      context.moveTo(-44, 0);
      context.quadraticCurveTo(-8, -20, 23, -8);
      context.lineTo(45, -25);
      context.lineTo(39, -5);
      context.quadraticCurveTo(55, 0, 63, 11);
      context.quadraticCurveTo(31, 18, 7, 11);
      context.lineTo(-15, 25);
      context.lineTo(-11, 9);
      context.quadraticCurveTo(-30, 8, -44, 0);
      context.fill();
      context.restore();
      shark.x += shark.speed * direction;
      if (direction > 0 && shark.x > width + 90) shark.x = -90;
      if (direction < 0 && shark.x < -90) shark.x = width + 90;
      shark.y += Math.sin(frame / 110 + shark.size) * .12;
    }

    function animate() {
      frame += 1;
      context.clearRect(0, 0, width, height);
      const light = context.createRadialGradient(width * .52, height * .05, 0, width * .52, height * .05, height * .8);
      light.addColorStop(0, "rgba(36, 119, 200, .065)");
      light.addColorStop(1, "rgba(4, 19, 41, 0)");
      context.fillStyle = light;
      context.fillRect(0, 0, width, height);
      particles.forEach((particle) => {
        context.beginPath();
        context.fillStyle = `rgba(146, 225, 247, ${particle.alpha})`;
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fill();
        if (!reducedMotion) {
          particle.y -= particle.speed;
          particle.x += Math.sin(frame / 65 + particle.y) * .12;
          if (particle.y < -4) { particle.y = height + 4; particle.x = random(0, width); }
        }
      });
      if (!reducedMotion) sharks.forEach(drawShark);
      if (!reducedMotion) animationId = window.requestAnimationFrame(animate);
    }
    resize();
    animate();
    window.addEventListener("resize", () => {
      window.cancelAnimationFrame(animationId);
      resize();
      animate();
    }, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) window.cancelAnimationFrame(animationId);
      else if (!reducedMotion) animate();
    });
  }

  function bindEvents() {
    $("#product-search").addEventListener("input", renderCatalog);
    $("#category-filter").addEventListener("click", (event) => {
      const button = event.target.closest("[data-category]");
      if (!button) return;
      selectedCategory = button.dataset.category;
      renderCatalog();
    });
    $("#product-grid").addEventListener("click", (event) => {
      const buyButton = event.target.closest("[data-add-cart]");
      if (buyButton) addToCart(buyButton.dataset.addCart);
      const detailButton = event.target.closest("[data-product-details]");
      if (detailButton) showProduct(detailButton.dataset.productDetails);
    });
    $("#open-cart").addEventListener("click", () => { $("#cart-title").innerHTML = "Savatcha<span>.</span>"; renderCart(); openDialog($("#cart-modal")); });
    $("#cart-content").addEventListener("click", (event) => {
      const change = event.target.closest("[data-cart-change]");
      const remove = event.target.closest("[data-cart-remove]");
      if (change) changeCartQuantity(change.dataset.cartChange, Number(change.dataset.delta));
      if (remove) changeCartQuantity(remove.dataset.cartRemove, -(cart[remove.dataset.cartRemove] || 0));
      if (event.target.closest("#start-checkout")) {
        if (cartProducts().length === 0) return notify("Savatchangiz bo‘sh.", "error");
        closeDialog($("#cart-modal"));
        $("#checkout-form").reset();
        locationCoordinates = null;
        $("#location-status").textContent = "GPS ixtiyoriy";
        toggleFulfillment();
        renderCheckoutSummary();
        openDialog($("#checkout-modal"));
      }
      if (event.target.closest("[data-close-dialog]")) closeDialog($("#cart-modal"));
    });
    $("#product-modal-content").addEventListener("click", (event) => {
      const button = event.target.closest("[data-add-cart]");
      if (button) {
        addToCart(button.dataset.addCart);
        closeDialog($("#product-modal"));
      }
    });
    $$("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => closeDialog(button.closest("dialog"))));
    $$("dialog").forEach((dialog) => {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) closeDialog(dialog);
      });
      dialog.addEventListener("close", () => {
        if (!$$("dialog[open]").length) document.body.classList.remove("modal-open");
      });
    });
    $$(".fulfillment-option input").forEach((radio) => radio.addEventListener("change", toggleFulfillment));
    $("#get-location").addEventListener("click", getCurrentLocation);
    $("#checkout-form").addEventListener("submit", submitOrder);
    $("#open-admin").addEventListener("click", () => {
      if (adminAuthenticated) {
        openAdminDashboard(currentAdminView);
        return;
      }
      updateAdminLoginMode();
      openDialog($("#admin-login-modal"));
    });
    $("#footer-admin").addEventListener("click", () => {
      if (adminAuthenticated) {
        openAdminDashboard(currentAdminView);
        return;
      }
      updateAdminLoginMode();
      openDialog($("#admin-login-modal"));
    });
    $("#admin-login-form").addEventListener("submit", handleAdminLogin);
    $("#toggle-password").addEventListener("click", () => {
      const input = $('#admin-login-form input[name="password"]');
      input.type = input.type === "password" ? "text" : "password";
    });
    $("#admin-logout").addEventListener("click", () => {
      adminAuthenticated = false;
      if (SUPABASE_ENABLED && supabaseSession) {
        void supabaseRequest("/auth/v1/logout", { method: "POST", authenticated: true, contentType: false })
          .catch((error) => notify(`Serverdan chiqishda xatolik: ${error.message}`, "error"))
          .finally(() => saveSupabaseSession(null));
      }
      if (!SUPABASE_ENABLED) saveSupabaseSession(null);
      closeDialog($("#admin-modal"));
      notify("Admin paneldan chiqdingiz.");
    });
    $(".admin-nav").addEventListener("click", (event) => {
      const button = event.target.closest("[data-admin-view]");
      if (button) setAdminView(button.dataset.adminView);
    });
    $("#admin-view-content").addEventListener("click", (event) => {
      if (event.target.closest("[data-admin-product-add]")) beginProductEdit();
      const edit = event.target.closest("[data-edit-product]");
      if (edit) beginProductEdit(edit.dataset.editProduct);
      const remove = event.target.closest("[data-delete-product]");
      if (remove) deleteProduct(remove.dataset.deleteProduct);
      const go = event.target.closest("[data-go-admin]");
      if (go) setAdminView(go.dataset.goAdmin);
    });
    $("#admin-view-content").addEventListener("change", (event) => {
      const select = event.target.closest("[data-order-status]");
      if (select) updateOrderStatus(select.dataset.orderStatus, select.value);
    });
    $("#admin-view-content").addEventListener("input", (event) => {
      if (event.target.id === "admin-order-search") {
        const position = event.target.selectionStart;
        renderAdminView();
        const input = $("#admin-order-search");
        input.focus();
        input.setSelectionRange(position, position);
      }
    });
    $("#admin-view-content").addEventListener("submit", (event) => {
      if (event.target.id === "settings-form") saveSettings(event);
    });
    $("#product-form").addEventListener("submit", saveProduct);
    $("#empty-contact").addEventListener("click", () => window.open("https://t.me/jamwidbek_official", "_blank", "noopener,noreferrer"));
    $("#mobile-menu-toggle").addEventListener("click", (event) => {
      const button = event.currentTarget;
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      $("#main-nav").classList.toggle("open", !expanded);
    });
    $$("#main-nav a").forEach((link) => link.addEventListener("click", () => {
      $("#main-nav").classList.remove("open");
      $("#mobile-menu-toggle").setAttribute("aria-expanded", "false");
    }));
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        $("#product-search").focus();
      }
      if (event.key === "Escape") {
        const open = $$("dialog[open]").at(-1);
        if (open) closeDialog(open);
      }
    });
    window.addEventListener("storage", syncFromOtherTab);
  }

  function init() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) document.documentElement.classList.add("reduced-motion");
    loadState();
    loadSupabaseSession();
    bindEvents();
    addCanvasAnimation();
    toggleFulfillment();
    void initializeBackend();
    if (SUPABASE_ENABLED) {
      window.setInterval(async () => {
        if (document.hidden) return;
        try {
          await loadRemoteProducts();
          if (adminAuthenticated) {
            await loadRemoteOrders();
            renderAdminView();
          }
        } catch (error) {
          notify(`Serverdan yangilashda xatolik: ${error.message}`, "error");
        }
      }, 30000);
    }
  }

  document.addEventListener("DOMContentLoaded", init, { once: true });
})();