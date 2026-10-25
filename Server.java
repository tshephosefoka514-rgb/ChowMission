import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.Reader;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.math.BigDecimal;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Chow Mission backend. ONE file, no extra libraries, needs Java 17 or newer.
 *
 * What it does
 *  - serves the website from the "public" folder
 *  - takes customer orders and messages and saves them to the "data" folder
 *  - gives the manager a password-protected dashboard (public/admin.html)
 *  - enforces the pre-order limit (default 40) on the server
 *  - optional online card payment through PayFast (see README.txt, "Online card payments")
 *
 * Run it from inside the chow-mission folder:   java Server.java
 * Prices are read from public/script.js, so edit prices there and restart the server.
 */
public class Server {

    /* ===================== settings ===================== */
    static int port = 8080;
    static int preorderLimit = 40;
    static int ordersPerHour = 10;          // per customer device
    static boolean trustProxy = false;      // true when a hosting service sits in front of the server
    static String adminPassword;
    static boolean firstRun = false;
    static Path publicDir = Paths.get("public").toAbsolutePath().normalize();
    static Path dataDir = Paths.get("data").toAbsolutePath().normalize();
    static int deliveryFee = 30;            // read from public/script.js
    static int preorderDays = 14;           // read from public/script.js

    // Online card payments (PayFast). All four of the first values are needed to switch it on.
    static String siteUrl = "";             // public web address of this site, e.g. https://chowmission.example
    static String pfMerchantId = "", pfMerchantKey = "", pfPassphrase = "";
    static boolean pfSandbox = false;       // true = PayFast test system, no real money
    static boolean pfValidate = true;       // double-check each payment notice with PayFast
    static long unpaidHoldMs = 30 * 60_000L; // an unpaid online order is cancelled after this long

    static final ZoneId SA = ZoneId.of("Africa/Johannesburg");
    static final SecureRandom RNG = new SecureRandom();
    static final int MAX_BODY = 50_000;
    // "unpaid" is set by the server only (online order waiting for its payment).
    static final Set<String> STATUSES = Set.of("new", "preparing", "ready", "completed", "cancelled");

    /* ===================== data ===================== */
    static class MenuItem { String id, name; int price; }

    static class OrderItem { String id, name; int qty, price; }

    static class Order {
        String ref, status = "new", type, name, phone, address = "", suburb = "";
        String payState = "", pfId = "";    // payState: "" (pay on arrival), "pending", "paid", "expired"
        String when, date = "", time = "", payment, notes = "";
        long createdAtMs;
        List<OrderItem> items = new ArrayList<>();
        int subtotal, fee, total;
    }

    static class Msg { String id, name, contact, message; long createdAtMs; }

    static class ApiError extends Exception {
        final int status; final String code;
        ApiError(int status, String code, String message) { super(message); this.status = status; this.code = code; }
    }

    static final Map<String, MenuItem> MENU = new LinkedHashMap<>();
    static final Object LOCK = new Object();
    static final List<Order> orders = new ArrayList<>();
    static final List<Msg> messages = new ArrayList<>();
    static int nextOrderNo = 1, nextMsgNo = 1;
    static long batchStartMs = 0;           // pre-orders are counted from this moment
    static Path storeFile;

    static final Map<String, Long> sessions = new ConcurrentHashMap<>();
    static final Map<String, Deque<Long>> hits = new ConcurrentHashMap<>();

    /* ===================== start up ===================== */
    public static void main(String[] args) throws Exception {
        loadSettings();
        if (!Files.exists(publicDir.resolve("index.html"))) {
            System.err.println("Cannot find the 'public' folder with index.html.");
            System.err.println("Start the server from INSIDE the chow-mission folder (the one that contains Server.java and public).");
            System.exit(1);
        }
        loadMenu();
        loadStore();

        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/", Server::handle);
        server.setExecutor(Executors.newFixedThreadPool(8));
        server.start();

        var timer = Executors.newSingleThreadScheduledExecutor(r -> { Thread t = new Thread(r); t.setDaemon(true); return t; });
        timer.scheduleAtFixedRate(() -> {
            try { synchronized (LOCK) { expireUnpaid(); } } catch (Throwable t) { t.printStackTrace(); }
        }, 1, 1, TimeUnit.MINUTES);

        System.out.println();
        System.out.println("  Chow Mission is running.");
        System.out.println("  Website:   http://localhost:" + port);
        System.out.println("  Manager:   http://localhost:" + port + "/admin.html");
        for (String ip : lanAddresses()) System.out.println("  On your Wi-Fi (phone/tablet): http://" + ip + ":" + port);
        if (firstRun) {
            System.out.println();
            System.out.println("  FIRST RUN. Your manager password is:  " + adminPassword);
            System.out.println("  It is saved in config.properties. Change it there if you like, then restart.");
        } else {
            System.out.println("  Manager password: see config.properties (or the ADMIN_PASSWORD setting).");
        }
        if (onlineEnabled()) {
            System.out.println("  Online card payment: ON (" + (pfSandbox ? "PayFast TEST system, no real money" : "PayFast LIVE") + "). Site address: " + siteUrl);
        } else {
            System.out.println("  Online card payment: off (see README.txt to switch it on).");
        }
        System.out.println("  Loaded " + MENU.size() + " menu items, " + orders.size() + " saved orders. Press Ctrl+C to stop.");
        System.out.println();
    }

    static void loadSettings() throws IOException {
        Properties p = new Properties();
        Path cfg = Paths.get("config.properties");
        if (Files.exists(cfg)) {
            try (Reader r = Files.newBufferedReader(cfg, StandardCharsets.UTF_8)) { p.load(r); }
        }
        port = toInt(first(System.getenv("PORT"), p.getProperty("port")), 8080);
        preorderLimit = toInt(first(System.getenv("PREORDER_LIMIT"), p.getProperty("preorderLimit")), 40);
        ordersPerHour = toInt(first(System.getenv("ORDERS_PER_HOUR"), p.getProperty("ordersPerHour")), 10);
        trustProxy = "true".equalsIgnoreCase(first(System.getenv("TRUST_PROXY"), p.getProperty("trustProxy")));
        String dd = first(System.getenv("DATA_DIR"), p.getProperty("dataDir"));
        if (dd != null) dataDir = Paths.get(dd).toAbsolutePath().normalize();

        String su = first(System.getenv("SITE_URL"), p.getProperty("siteUrl"));
        siteUrl = su == null ? "" : su.replaceAll("/+$", "");
        pfMerchantId = nz(first(System.getenv("PAYFAST_MERCHANT_ID"), p.getProperty("payfastMerchantId")));
        pfMerchantKey = nz(first(System.getenv("PAYFAST_MERCHANT_KEY"), p.getProperty("payfastMerchantKey")));
        pfPassphrase = nz(first(System.getenv("PAYFAST_PASSPHRASE"), p.getProperty("payfastPassphrase")));
        pfSandbox = "true".equalsIgnoreCase(first(System.getenv("PAYFAST_SANDBOX"), p.getProperty("payfastSandbox")));
        String pv = first(System.getenv("PAYFAST_VALIDATE"), p.getProperty("payfastValidate"));
        pfValidate = pv == null || !pv.equalsIgnoreCase("false");
        unpaidHoldMs = toInt(first(System.getenv("UNPAID_HOLD_MINUTES"), p.getProperty("unpaidHoldMinutes")), 30) * 60_000L;

        adminPassword = first(System.getenv("ADMIN_PASSWORD"), p.getProperty("adminPassword"));
        if (adminPassword == null) {
            adminPassword = randomPassword(10);
            firstRun = true;
            String text = "# Chow Mission settings. Restart the server after changing anything here.\n"
                    + "# The manager logs in at /admin.html with this password.\n"
                    + "adminPassword=" + adminPassword + "\n"
                    + "port=" + port + "\n"
                    + "preorderLimit=" + preorderLimit + "\n"
                    + "\n# Online card payments (PayFast). Remove the # and fill these in to switch it on. See README.txt.\n"
                    + "# siteUrl=https://your-website-address\n"
                    + "# payfastMerchantId=\n"
                    + "# payfastMerchantKey=\n"
                    + "# payfastPassphrase=\n"
                    + "# payfastSandbox=true\n";
            try { Files.writeString(cfg, text, StandardCharsets.UTF_8); }
            catch (IOException e) { System.out.println("Could not save config.properties: " + e.getMessage()); }
        }
    }

    static String first(String a, String b) {
        if (a != null && !a.isBlank()) return a.trim();
        if (b != null && !b.isBlank()) return b.trim();
        return null;
    }

    static String nz(String s) { return s == null ? "" : s; }

    static boolean onlineEnabled() {
        return !pfMerchantId.isEmpty() && !pfMerchantKey.isEmpty() && !pfPassphrase.isEmpty()
                && (siteUrl.startsWith("https://") || siteUrl.startsWith("http://"));
    }

    static int toInt(String s, int fallback) {
        try { return s == null ? fallback : Integer.parseInt(s); } catch (NumberFormatException e) { return fallback; }
    }

    static String randomPassword(int len) {
        String alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < len; i++) b.append(alphabet.charAt(RNG.nextInt(alphabet.length())));
        return b.toString();
    }

    static String slug(String s) {
        return s.toLowerCase().replaceAll("[^a-z0-9]+", "-").replaceAll("(^-|-$)", "");
    }

    /** Reads the menu (names and prices), delivery fee and pre-order window from public/script.js. */
    static void loadMenu() throws IOException {
        String js = Files.readString(publicDir.resolve("script.js"), StandardCharsets.UTF_8);
        Matcher m = Pattern.compile("n:\\s*\"([^\"]+)\"\\s*,\\s*p:\\s*(\\d+)").matcher(js);
        while (m.find()) {
            MenuItem it = new MenuItem();
            it.name = m.group(1);
            it.id = slug(it.name);
            it.price = Integer.parseInt(m.group(2));
            MENU.put(it.id, it);
        }
        if (MENU.isEmpty()) throw new IOException("Could not read any menu items from public/script.js");
        Matcher f = Pattern.compile("DELIVERY_FEE\\s*=\\s*(\\d+)").matcher(js);
        if (f.find()) deliveryFee = Integer.parseInt(f.group(1));
        Matcher d = Pattern.compile("PREORDER_DAYS\\s*=\\s*(\\d+)").matcher(js);
        if (d.find()) preorderDays = Integer.parseInt(d.group(1));
    }

    static List<String> lanAddresses() {
        List<String> out = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            while (nis != null && nis.hasMoreElements()) {
                NetworkInterface ni = nis.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : java.util.Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) out.add(a.getHostAddress());
                }
            }
        } catch (Exception ignored) { }
        return out;
    }

    /* ===================== saving to disk ===================== */
    static String esc(String s) {
        StringBuilder b = new StringBuilder();
        for (char c : s.toCharArray()) {
            switch (c) {
                case '\\' -> b.append("\\\\");
                case '\t' -> b.append("\\t");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                default -> b.append(c);
            }
        }
        return b.toString();
    }

    static String unesc(String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\' && i + 1 < s.length()) {
                char n = s.charAt(++i);
                switch (n) {
                    case 't' -> b.append('\t');
                    case 'n' -> b.append('\n');
                    case 'r' -> b.append('\r');
                    default -> b.append(n);
                }
            } else {
                b.append(c);
            }
        }
        return b.toString();
    }

    static String orderLine(Order o) {
        StringBuilder items = new StringBuilder();
        for (OrderItem i : o.items) {
            if (items.length() > 0) items.append('\u001e');
            items.append(i.id).append('\u001f').append(i.name).append('\u001f').append(i.qty).append('\u001f').append(i.price);
        }
        String[] f = {
            "ORDER", o.ref, String.valueOf(o.createdAtMs), o.status, o.type, o.name, o.phone, o.address, o.suburb,
            o.when, o.date, o.time, o.payment, o.notes, items.toString(),
            String.valueOf(o.subtotal), String.valueOf(o.fee), String.valueOf(o.total),
            o.payState, o.pfId
        };
        StringBuilder line = new StringBuilder();
        for (int i = 0; i < f.length; i++) {
            if (i > 0) line.append('\t');
            line.append(esc(f[i]));
        }
        return line.toString();
    }

    static Order parseOrder(String[] f) {
        Order o = new Order();
        o.ref = unesc(f[1]);
        o.createdAtMs = Long.parseLong(f[2]);
        o.status = unesc(f[3]);
        o.type = unesc(f[4]);
        o.name = unesc(f[5]);
        o.phone = unesc(f[6]);
        o.address = unesc(f[7]);
        o.suburb = unesc(f[8]);
        o.when = unesc(f[9]);
        o.date = unesc(f[10]);
        o.time = unesc(f[11]);
        o.payment = unesc(f[12]);
        o.notes = unesc(f[13]);
        String items = unesc(f[14]);
        if (!items.isEmpty()) {
            for (String part : items.split("\u001e")) {
                String[] p = part.split("\u001f", -1);
                OrderItem it = new OrderItem();
                it.id = p[0]; it.name = p[1]; it.qty = Integer.parseInt(p[2]); it.price = Integer.parseInt(p[3]);
                o.items.add(it);
            }
        }
        o.subtotal = Integer.parseInt(f[15]);
        o.fee = Integer.parseInt(f[16]);
        o.total = Integer.parseInt(f[17]);
        if (f.length > 19) { o.payState = unesc(f[18]); o.pfId = unesc(f[19]); }   // older saved files do not have these
        return o;
    }

    static String msgLine(Msg m) {
        return "MSG\t" + esc(m.id) + "\t" + m.createdAtMs + "\t" + esc(m.name) + "\t" + esc(m.contact) + "\t" + esc(m.message);
    }

    static void loadStore() throws IOException {
        Files.createDirectories(dataDir);
        storeFile = dataDir.resolve("store.txt");
        if (!Files.exists(storeFile)) return;
        int bad = 0;
        for (String line : Files.readAllLines(storeFile, StandardCharsets.UTF_8)) {
            if (line.isBlank()) continue;
            try {
                String[] f = line.split("\t", -1);
                switch (f[0]) {
                    case "META" -> {
                        nextOrderNo = Integer.parseInt(f[1]);
                        nextMsgNo = Integer.parseInt(f[2]);
                        batchStartMs = Long.parseLong(f[3]);
                    }
                    case "ORDER" -> orders.add(parseOrder(f));
                    case "MSG" -> {
                        Msg m = new Msg();
                        m.id = unesc(f[1]); m.createdAtMs = Long.parseLong(f[2]);
                        m.name = unesc(f[3]); m.contact = unesc(f[4]); m.message = unesc(f[5]);
                        messages.add(m);
                    }
                    default -> bad++;
                }
            } catch (RuntimeException e) {
                bad++;
            }
        }
        if (bad > 0) {
            Path keep = dataDir.resolve("store-unreadable-" + System.currentTimeMillis() + ".txt");
            Files.copy(storeFile, keep);
            System.out.println("Warning: " + bad + " unreadable line(s) in store.txt were skipped. A copy was kept as " + keep.getFileName());
        }
    }

    /** Must be called while holding LOCK. Writes everything to disk safely (temp file, then rename). */
    static void save() throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("META\t").append(nextOrderNo).append('\t').append(nextMsgNo).append('\t').append(batchStartMs).append('\n');
        for (Order o : orders) sb.append(orderLine(o)).append('\n');
        for (Msg m : messages) sb.append(msgLine(m)).append('\n');
        Path tmp = dataDir.resolve("store.tmp");
        Files.writeString(tmp, sb.toString(), StandardCharsets.UTF_8);
        if (Files.exists(storeFile)) Files.copy(storeFile, dataDir.resolve("store.bak"), StandardCopyOption.REPLACE_EXISTING);
        try {
            Files.move(tmp, storeFile, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(tmp, storeFile, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    /* ===================== helpers ===================== */
    static int taken() {   // pre-orders in the current batch that are not cancelled (call while holding LOCK)
        int n = 0;
        for (Order o : orders) {
            if (o.when.equals("preorder") && !o.status.equals("cancelled") && o.createdAtMs >= batchStartMs) n++;
        }
        return n;
    }

    /** Must be called while holding LOCK. Cancels online orders that were never paid. */
    static void expireUnpaid() throws IOException {
        long now = System.currentTimeMillis();
        boolean changed = false;
        for (Order o : orders) {
            if (o.status.equals("unpaid") && o.payState.equals("pending") && now - o.createdAtMs > unpaidHoldMs) {
                o.status = "cancelled"; o.payState = "expired"; changed = true;
                System.out.println("Order " + o.ref + " was not paid in time and was cancelled.");
            }
        }
        if (changed) save();
    }

    static String q(String s) {   // JSON string
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> {
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
                }
            }
        }
        return b.append('"').toString();
    }

    static String err(String message, String code) {
        return "{\"error\":" + q(message) + ",\"code\":" + q(code) + "}";
    }

    static String orderJson(Order o) {
        StringBuilder b = new StringBuilder("{");
        b.append("\"ref\":").append(q(o.ref));
        b.append(",\"createdAtMs\":").append(o.createdAtMs);
        b.append(",\"status\":").append(q(o.status));
        b.append(",\"type\":").append(q(o.type));
        b.append(",\"name\":").append(q(o.name));
        b.append(",\"phone\":").append(q(o.phone));
        b.append(",\"address\":").append(q(o.address));
        b.append(",\"suburb\":").append(q(o.suburb));
        b.append(",\"when\":").append(q(o.when));
        b.append(",\"date\":").append(q(o.date));
        b.append(",\"time\":").append(q(o.time));
        b.append(",\"payment\":").append(q(o.payment));
        b.append(",\"payState\":").append(q(o.payState));
        b.append(",\"notes\":").append(q(o.notes));
        b.append(",\"items\":[");
        for (int i = 0; i < o.items.size(); i++) {
            OrderItem it = o.items.get(i);
            if (i > 0) b.append(',');
            b.append("{\"id\":").append(q(it.id)).append(",\"name\":").append(q(it.name))
             .append(",\"qty\":").append(it.qty).append(",\"price\":").append(it.price).append('}');
        }
        b.append("],\"subtotal\":").append(o.subtotal).append(",\"fee\":").append(o.fee).append(",\"total\":").append(o.total).append('}');
        return b.toString();
    }

    static String msgJson(Msg m) {
        return "{\"id\":" + q(m.id) + ",\"createdAtMs\":" + m.createdAtMs + ",\"name\":" + q(m.name)
                + ",\"contact\":" + q(m.contact) + ",\"message\":" + q(m.message) + "}";
    }

    static Map<String, String> parseForm(String body) {
        Map<String, String> m = new LinkedHashMap<>();   // keeps the order (PayFast signatures depend on it)
        for (String pair : body.split("&")) {
            if (pair.isEmpty()) continue;
            int i = pair.indexOf('=');
            String k = URLDecoder.decode(i < 0 ? pair : pair.substring(0, i), StandardCharsets.UTF_8);
            String v = i < 0 ? "" : URLDecoder.decode(pair.substring(i + 1), StandardCharsets.UTF_8);
            m.put(k, v);
        }
        return m;
    }

    static String clean(String s, int max) {   // one line of plain text
        if (s == null) return "";
        String t = s.replaceAll("\\p{Cntrl}", " ").replaceAll("\\s+", " ").trim();
        return t.length() > max ? t.substring(0, max) : t;
    }

    static String cleanMulti(String s, int max) {   // text that may have line breaks
        if (s == null) return "";
        String t = s.replace("\r", "").replaceAll("[\\p{Cntrl}&&[^\n]]", " ").trim();
        return t.length() > max ? t.substring(0, max) : t;
    }

    static ApiError bad(String message) { return new ApiError(400, "invalid", message); }

    static String readBody(HttpExchange ex) throws IOException, ApiError {
        byte[] b = ex.getRequestBody().readNBytes(MAX_BODY + 1);
        if (b.length > MAX_BODY) throw new ApiError(413, "invalid", "Request too large.");
        return new String(b, StandardCharsets.UTF_8);
    }

    static String clientIp(HttpExchange ex) {
        if (trustProxy) {
            String xff = ex.getRequestHeaders().getFirst("X-Forwarded-For");
            if (xff != null && !xff.isBlank()) {
                String[] parts = xff.split(",");
                return parts[parts.length - 1].trim();
            }
        }
        return ex.getRemoteAddress().getAddress().getHostAddress();
    }

    static boolean rateLimited(String key, int max, long windowMs) {
        long now = System.currentTimeMillis();
        Deque<Long> d = hits.computeIfAbsent(key, k -> new ArrayDeque<>());
        synchronized (d) {
            while (!d.isEmpty() && now - d.peekFirst() > windowMs) d.pollFirst();
            if (d.size() >= max) return true;
            d.addLast(now);
            return false;
        }
    }

    static boolean passwordOk(String given) {
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            byte[] a = sha.digest(given.getBytes(StandardCharsets.UTF_8));
            byte[] b = sha.digest(adminPassword.getBytes(StandardCharsets.UTF_8));
            return MessageDigest.isEqual(a, b);
        } catch (Exception e) {
            return false;
        }
    }

    static String newSession() {
        byte[] b = new byte[24];
        RNG.nextBytes(b);
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        sessions.put(s.toString(), System.currentTimeMillis() + 12L * 3600 * 1000);
        return s.toString();
    }

    static String bearer(HttpExchange ex) {
        String h = ex.getRequestHeaders().getFirst("Authorization");
        return (h != null && h.startsWith("Bearer ")) ? h.substring(7).trim() : "";
    }

    static void requireAdmin(HttpExchange ex) throws ApiError {
        String t = bearer(ex);
        Long exp = t.isEmpty() ? null : sessions.get(t);
        if (exp == null || exp < System.currentTimeMillis()) {
            if (exp != null) sessions.remove(t);
            throw new ApiError(401, "auth", "Please log in again.");
        }
    }

    /* ===================== request handling ===================== */
    static void handle(HttpExchange ex) {
        try {
            String path = ex.getRequestURI().getPath();
            String method = ex.getRequestMethod();
            if (path.startsWith("/api/")) {
                api(ex, path, method);
            } else if (method.equals("GET") || method.equals("HEAD")) {
                serveStatic(ex, path, method.equals("HEAD"));
            } else {
                sendJson(ex, 405, err("Method not allowed", "invalid"));
            }
        } catch (ApiError e) {
            trySend(ex, e.status, err(e.getMessage(), e.code));
        } catch (IllegalArgumentException e) {
            trySend(ex, 400, err("Bad request.", "invalid"));
        } catch (Exception e) {
            e.printStackTrace();
            trySend(ex, 500, err("Server problem. Please try again.", "server"));
        } finally {
            ex.close();
        }
    }

    static void trySend(HttpExchange ex, int status, String json) {
        try { sendJson(ex, status, json); } catch (Exception ignored) { }
    }

    static void sendJson(HttpExchange ex, int status, String json) throws IOException {
        byte[] data = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        ex.sendResponseHeaders(status, data.length);
        ex.getResponseBody().write(data);
    }

    static void need(boolean ok) throws ApiError {
        if (!ok) throw new ApiError(405, "invalid", "Method not allowed");
    }

    static void api(HttpExchange ex, String path, String method) throws Exception {
        boolean get = method.equals("GET"), post = method.equals("POST");
        switch (path) {
            case "/api/preorder-status" -> {
                need(get);
                synchronized (LOCK) {
                    expireUnpaid();
                    sendJson(ex, 200, "{\"limit\":" + preorderLimit + ",\"taken\":" + taken() + "}");
                }
            }
            case "/api/payment-config" -> {
                need(get);
                sendJson(ex, 200, "{\"online\":" + onlineEnabled() + ",\"sandbox\":" + pfSandbox + "}");
            }
            case "/api/payment-status" -> { need(get); paymentStatus(ex); }
            case "/api/payfast-notify" -> { need(post); payfastNotify(ex); }
            case "/api/orders" -> { need(post); createOrder(ex); }
            case "/api/messages" -> { need(post); createMessage(ex); }
            case "/api/admin/login" -> { need(post); login(ex); }
            case "/api/admin/logout" -> {
                need(post);
                sessions.remove(bearer(ex));
                sendJson(ex, 200, "{\"ok\":true}");
            }
            case "/api/admin/me" -> { need(get); requireAdmin(ex); sendJson(ex, 200, "{\"ok\":true}"); }
            case "/api/admin/orders" -> { need(get); requireAdmin(ex); listOrders(ex); }
            case "/api/admin/messages" -> { need(get); requireAdmin(ex); listMessages(ex); }
            case "/api/admin/status" -> { need(post); requireAdmin(ex); setStatus(ex); }
            case "/api/admin/message-delete" -> { need(post); requireAdmin(ex); deleteMessage(ex); }
            case "/api/admin/new-batch" -> { need(post); requireAdmin(ex); newBatch(ex); }
            case "/api/admin/mark-paid" -> { need(post); requireAdmin(ex); markPaid(ex); }
            default -> throw new ApiError(404, "invalid", "Not found.");
        }
    }

    /* ---------- customers ---------- */
    static void createOrder(HttpExchange ex) throws Exception {
        if (rateLimited("order:" + clientIp(ex), ordersPerHour, 3_600_000L)) {
            throw new ApiError(429, "rate", "Too many orders from this device. Please call us on +27 78 312 1534.");
        }
        Map<String, String> f = parseForm(readBody(ex));
        Order o = buildOrder(f);
        synchronized (LOCK) {
            expireUnpaid();
            if (o.when.equals("preorder") && taken() >= preorderLimit) {
                throw new ApiError(409, "full", "Sorry, pre-orders are full.");
            }
            o.ref = String.format("CM-%04d", nextOrderNo++);
            o.createdAtMs = System.currentTimeMillis();
            orders.add(o);
            try { save(); } catch (IOException e) { orders.remove(o); nextOrderNo--; throw e; }
        }
        System.out.println("New order " + o.ref + ": " + o.type + (o.when.equals("preorder") ? " (pre-order " + o.date + " " + o.time + ")" : "")
                + ", R" + o.total + ", " + o.name + (o.payState.equals("pending") ? " [waiting for online payment]" : ""));
        if (o.payState.equals("pending")) {
            sendJson(ex, 201, "{\"ok\":true,\"ref\":" + q(o.ref) + ",\"pay\":" + payfastJson(o) + "}");
        } else {
            sendJson(ex, 201, "{\"ok\":true,\"ref\":" + q(o.ref) + "}");
        }
    }

    /** Checks everything the customer sent. Prices always come from the menu, never from the browser. */
    static Order buildOrder(Map<String, String> f) throws ApiError {
        Order o = new Order();
        String type = f.getOrDefault("type", "");
        if (!type.equals("Delivery") && !type.equals("Collection")) throw bad("Please choose delivery or collection.");
        o.type = type;
        boolean delivery = type.equals("Delivery");

        o.name = clean(f.get("name"), 80);
        if (o.name.length() < 2) throw bad("Please enter your name.");
        o.phone = clean(f.get("phone"), 20);
        if (!o.phone.replaceAll("[\\s-]", "").matches("^(\\+?27|0)\\d{9}$")) throw bad("Please enter a valid South African phone number.");

        if (delivery) {
            o.address = clean(f.get("address"), 200);
            if (o.address.length() < 6) throw bad("Please enter your delivery address.");
            o.suburb = clean(f.get("suburb"), 80);
        }

        // items arrive as  id:qty,id:qty
        Map<String, Integer> qty = new LinkedHashMap<>();
        String raw = f.getOrDefault("items", "");
        String[] parts = raw.isEmpty() ? new String[0] : raw.split(",");
        if (parts.length == 0 || parts.length > 40) throw bad("Your order is empty.");
        int totalQty = 0;
        for (String part : parts) {
            String[] kv = part.split(":");
            if (kv.length != 2 || !MENU.containsKey(kv[0])) throw bad("One of the items is not on the menu. Please refresh the page and try again.");
            int n;
            try { n = Integer.parseInt(kv[1].trim()); } catch (NumberFormatException e) { throw bad("Invalid quantity."); }
            if (n < 1 || n > 20) throw bad("Each item can be ordered 1 to 20 times.");
            qty.merge(kv[0], n, Integer::sum);
            totalQty += n;
        }
        if (totalQty > 60) throw bad("That is a big order. Please call us on +27 78 312 1534.");
        for (Map.Entry<String, Integer> e : qty.entrySet()) {
            MenuItem mi = MENU.get(e.getKey());
            OrderItem it = new OrderItem();
            it.id = mi.id; it.name = mi.name; it.price = mi.price; it.qty = e.getValue();
            o.items.add(it);
            o.subtotal += it.price * it.qty;
        }
        o.fee = delivery ? deliveryFee : 0;
        o.total = o.subtotal + o.fee;

        o.when = f.getOrDefault("when", "asap").equals("preorder") ? "preorder" : "asap";
        if (o.when.equals("preorder")) {
            String date = clean(f.get("date"), 10), time = clean(f.get("time"), 5);
            LocalDate d;
            try { d = LocalDate.parse(date); } catch (DateTimeParseException e) { throw bad("Please choose a pre-order date."); }
            LocalDate today = LocalDate.now(SA);
            if (d.isBefore(today) || d.isAfter(today.plusDays(preorderDays))) {
                throw bad("Pre-orders can be placed from today up to " + preorderDays + " days ahead.");
            }
            if (!time.matches("^([01]\\d|2[0-3]):[0-5]\\d$")) throw bad("Please choose a pre-order time.");
            o.date = date; o.time = time;
        }

        String pay = f.getOrDefault("payment", "Cash");
        if (pay.equals("Online")) {
            if (!onlineEnabled()) throw bad("Online payment is not available right now. Please choose another way to pay.");
            o.payment = "Online"; o.payState = "pending"; o.status = "unpaid";   // goes to the kitchen once PayFast confirms
        } else {
            o.payment = (pay.equals("Card") || pay.equals("EFT")) ? pay : "Cash";
        }
        o.notes = cleanMulti(f.get("notes"), 500);
        return o;
    }

    static void createMessage(HttpExchange ex) throws Exception {
        if (rateLimited("msg:" + clientIp(ex), 5, 3_600_000L)) {
            throw new ApiError(429, "rate", "Too many messages from this device. Please call us on +27 78 312 1534.");
        }
        Map<String, String> f = parseForm(readBody(ex));
        Msg m = new Msg();
        m.name = clean(f.get("name"), 80);
        m.contact = clean(f.get("contact"), 80);
        m.message = cleanMulti(f.get("message"), 1000);
        if (m.name.length() < 2) throw bad("Please enter your name.");
        if (m.contact.length() < 5) throw bad("Please enter a phone number or email so we can reply.");
        if (m.message.length() < 5) throw bad("Please write a message.");
        synchronized (LOCK) {
            m.id = String.format("M-%04d", nextMsgNo++);
            m.createdAtMs = System.currentTimeMillis();
            messages.add(m);
            try { save(); } catch (IOException e) { messages.remove(m); nextMsgNo--; throw e; }
        }
        System.out.println("New message " + m.id + " from " + m.name);
        sendJson(ex, 201, "{\"ok\":true}");
    }

    /* ---------- manager ---------- */
    static void login(HttpExchange ex) throws Exception {
        if (rateLimited("login:" + clientIp(ex), 8, 15 * 60_000L)) {
            throw new ApiError(429, "rate", "Too many login attempts. Please wait 15 minutes.");
        }
        Map<String, String> f = parseForm(readBody(ex));
        if (!passwordOk(f.getOrDefault("password", ""))) throw new ApiError(401, "auth", "Wrong password.");
        sendJson(ex, 200, "{\"token\":" + q(newSession()) + "}");
    }

    static void listOrders(HttpExchange ex) throws IOException {
        String json;
        synchronized (LOCK) {
            StringBuilder sb = new StringBuilder("{\"limit\":" + preorderLimit + ",\"taken\":" + taken() + ",\"orders\":[");
            int n = 0;
            for (int i = orders.size() - 1; i >= 0 && n < 300; i--, n++) {
                if (n > 0) sb.append(',');
                sb.append(orderJson(orders.get(i)));
            }
            json = sb.append("]}").toString();
        }
        sendJson(ex, 200, json);
    }

    static void listMessages(HttpExchange ex) throws IOException {
        String json;
        synchronized (LOCK) {
            StringBuilder sb = new StringBuilder("{\"messages\":[");
            int n = 0;
            for (int i = messages.size() - 1; i >= 0 && n < 200; i--, n++) {
                if (n > 0) sb.append(',');
                sb.append(msgJson(messages.get(i)));
            }
            json = sb.append("]}").toString();
        }
        sendJson(ex, 200, json);
    }

    static void setStatus(HttpExchange ex) throws Exception {
        Map<String, String> f = parseForm(readBody(ex));
        String status = f.getOrDefault("status", "");
        if (!STATUSES.contains(status)) throw bad("Unknown status.");
        synchronized (LOCK) {
            Order found = null;
            for (Order o : orders) if (o.ref.equals(f.get("ref"))) { found = o; break; }
            if (found == null) throw new ApiError(404, "invalid", "Order not found.");
            if (found.payState.equals("pending") && !status.equals("cancelled")) {
                throw bad("This order has not been paid online yet. Use 'Mark as paid' first, or cancel it.");
            }
            String old = found.status;
            found.status = status;
            try { save(); } catch (IOException e) { found.status = old; throw e; }
        }
        sendJson(ex, 200, "{\"ok\":true}");
    }

    static void deleteMessage(HttpExchange ex) throws Exception {
        Map<String, String> f = parseForm(readBody(ex));
        synchronized (LOCK) {
            Msg found = null;
            for (Msg m : messages) if (m.id.equals(f.get("id"))) { found = m; break; }
            if (found == null) throw new ApiError(404, "invalid", "Message not found.");
            int index = messages.indexOf(found);
            messages.remove(found);
            try { save(); } catch (IOException e) { messages.add(index, found); throw e; }
        }
        sendJson(ex, 200, "{\"ok\":true}");
    }

    static void newBatch(HttpExchange ex) throws Exception {
        synchronized (LOCK) {
            long old = batchStartMs;
            batchStartMs = System.currentTimeMillis();
            try { save(); } catch (IOException e) { batchStartMs = old; throw e; }
        }
        System.out.println("Started a new pre-order batch.");
        sendJson(ex, 200, "{\"ok\":true}");
    }

    /* ===================== online card payment (PayFast) ===================== */
    static String pfEnc(String s) {   // same encoding as PHP urlencode, which PayFast uses
        return URLEncoder.encode(s.trim(), StandardCharsets.UTF_8).replace("*", "%2A");
    }

    /** key=value&key=value in the given order. "signature" is skipped. */
    static String pfParamString(Map<String, String> f) {
        StringBuilder b = new StringBuilder();
        for (Map.Entry<String, String> e : f.entrySet()) {
            if (e.getKey().equals("signature")) continue;
            if (b.length() > 0) b.append('&');
            b.append(e.getKey()).append('=').append(pfEnc(e.getValue()));
        }
        return b.toString();
    }

    static String pfSignature(Map<String, String> f) {
        String s = pfParamString(f) + "&passphrase=" + pfEnc(pfPassphrase);
        try {
            byte[] d = MessageDigest.getInstance("MD5").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder h = new StringBuilder();
            for (byte x : d) h.append(String.format("%02x", x));
            return h.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** What the browser posts to PayFast to pay for one order. The total comes from the saved order, never from the browser. */
    static String payfastJson(Order o) {
        Map<String, String> f = new LinkedHashMap<>();
        f.put("merchant_id", pfMerchantId);
        f.put("merchant_key", pfMerchantKey);
        f.put("return_url", siteUrl + "/order.html?paid=" + o.ref);
        f.put("cancel_url", siteUrl + "/order.html?cancelled=" + o.ref);
        f.put("notify_url", siteUrl + "/api/payfast-notify");
        f.put("name_first", o.name.split(" ")[0]);
        f.put("m_payment_id", o.ref);
        f.put("amount", o.total + ".00");
        f.put("item_name", "Chow Mission order " + o.ref);
        f.put("signature", pfSignature(f));
        StringBuilder b = new StringBuilder("{\"url\":");
        b.append(q(pfSandbox ? "https://sandbox.payfast.co.za/eng/process" : "https://www.payfast.co.za/eng/process"));
        b.append(",\"fields\":{");
        boolean first = true;
        for (Map.Entry<String, String> e : f.entrySet()) {
            if (!first) b.append(',');
            first = false;
            b.append(q(e.getKey())).append(':').append(q(e.getValue()));
        }
        return b.append("}}").toString();
    }

    /** Asks PayFast itself whether this payment notice is real. */
    static boolean pfServerSaysValid(Map<String, String> f) {
        try {
            String host = pfSandbox ? "https://sandbox.payfast.co.za" : "https://www.payfast.co.za";
            HttpRequest req = HttpRequest.newBuilder(URI.create(host + "/eng/query/validate"))
                    .timeout(Duration.ofSeconds(10))
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .POST(HttpRequest.BodyPublishers.ofString(pfParamString(f)))
                    .build();
            HttpResponse<String> r = HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());
            return r.body().trim().equals("VALID");
        } catch (Exception e) {
            System.out.println("Could not reach PayFast to check a payment notice: " + e.getMessage());
            return false;
        }
    }

    /** PayFast calls this by itself after the customer pays. Nothing here trusts the browser. */
    static void payfastNotify(HttpExchange ex) throws Exception {
        if (!onlineEnabled()) throw new ApiError(404, "invalid", "Not found.");
        Map<String, String> f = parseForm(readBody(ex));
        String sig = f.getOrDefault("signature", "");
        if (!MessageDigest.isEqual(sig.toLowerCase().getBytes(StandardCharsets.UTF_8), pfSignature(f).getBytes(StandardCharsets.UTF_8))) {
            System.out.println("Rejected a payment notice with a wrong signature.");
            throw bad("Bad signature.");
        }
        if (!pfMerchantId.equals(f.getOrDefault("merchant_id", ""))) throw bad("Wrong merchant.");
        if (pfValidate && !pfServerSaysValid(f)) throw bad("PayFast did not confirm this notice.");

        String ref = f.getOrDefault("m_payment_id", "");
        synchronized (LOCK) {
            Order o = null;
            for (Order x : orders) if (x.ref.equals(ref)) { o = x; break; }
            if (o == null || !o.payment.equals("Online")) throw new ApiError(404, "invalid", "Unknown order.");
            BigDecimal paid;
            try { paid = new BigDecimal(f.getOrDefault("amount_gross", "")); } catch (NumberFormatException e) { throw bad("Bad amount."); }
            if (paid.compareTo(BigDecimal.valueOf(o.total)) != 0) {
                System.out.println("Rejected payment for " + ref + ": amount " + paid + " does not match R" + o.total);
                throw bad("Amount does not match.");
            }
            if (f.getOrDefault("payment_status", "").equals("COMPLETE") && !o.payState.equals("paid")) {
                String oldPay = o.payState, oldStatus = o.status, oldId = o.pfId;
                o.payState = "paid"; o.pfId = f.getOrDefault("pf_payment_id", "");
                if (o.status.equals("unpaid") || o.status.equals("cancelled")) o.status = "new";   // a late payment still gets cooked
                try { save(); } catch (IOException e) { o.payState = oldPay; o.status = oldStatus; o.pfId = oldId; throw e; }
                System.out.println("Order " + o.ref + " PAID online (R" + o.total + ").");
            }
        }
        sendJson(ex, 200, "{\"ok\":true}");
    }

    /** Lets the customer's page ask whether its payment has been confirmed. Gives away nothing else. */
    static void paymentStatus(HttpExchange ex) throws IOException {
        String qs = ex.getRequestURI().getRawQuery();
        String ref = qs == null ? "" : parseForm(qs).getOrDefault("ref", "");
        boolean paid = false;
        synchronized (LOCK) {
            for (Order o : orders) if (o.ref.equals(ref) && o.payState.equals("paid")) paid = true;
        }
        sendJson(ex, 200, "{\"paid\":" + paid + "}");
    }

    /** Manager button, for when a payment is confirmed in PayFast but the automatic notice did not arrive. */
    static void markPaid(HttpExchange ex) throws Exception {
        Map<String, String> f = parseForm(readBody(ex));
        synchronized (LOCK) {
            Order o = null;
            for (Order x : orders) if (x.ref.equals(f.get("ref"))) { o = x; break; }
            if (o == null) throw new ApiError(404, "invalid", "Order not found.");
            if (!o.payment.equals("Online")) throw bad("This order is not an online payment order.");
            String oldPay = o.payState, oldStatus = o.status;
            o.payState = "paid";
            if (o.status.equals("unpaid") || o.status.equals("cancelled")) o.status = "new";
            try { save(); } catch (IOException e) { o.payState = oldPay; o.status = oldStatus; throw e; }
            System.out.println("Order " + o.ref + " marked as paid by the manager.");
        }
        sendJson(ex, 200, "{\"ok\":true}");
    }

    /* ===================== website files ===================== */
    static String mime(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html")) return "text/html; charset=utf-8";
        if (n.endsWith(".css")) return "text/css; charset=utf-8";
        if (n.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (n.endsWith(".json")) return "application/json; charset=utf-8";
        if (n.endsWith(".txt")) return "text/plain; charset=utf-8";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".ico")) return "image/x-icon";
        if (n.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    static void serveStatic(HttpExchange ex, String path, boolean headOnly) throws IOException {
        if (path.equals("/")) path = "/index.html";
        Path file;
        try {
            file = publicDir.resolve(path.substring(1)).normalize();
        } catch (RuntimeException e) {
            file = null;
        }
        if (file == null || !file.startsWith(publicDir) || !Files.isRegularFile(file)) {
            byte[] msg = "Page not found".getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
            ex.sendResponseHeaders(404, headOnly ? -1 : msg.length);
            if (!headOnly) ex.getResponseBody().write(msg);
            return;
        }
        byte[] data = Files.readAllBytes(file);
        String name = file.getFileName().toString();
        ex.getResponseHeaders().set("Content-Type", mime(name));
        ex.getResponseHeaders().set("Cache-Control", "no-cache");
        ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        if (name.equals("admin.html")) ex.getResponseHeaders().set("X-Robots-Tag", "noindex, nofollow");
        if (headOnly || data.length == 0) {
            ex.sendResponseHeaders(200, -1);
        } else {
            ex.sendResponseHeaders(200, data.length);
            ex.getResponseBody().write(data);
        }
    }
}