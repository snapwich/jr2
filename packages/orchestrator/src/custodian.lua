-- The Custodian's decisions (ADR-0059), run by Envoy's Lua filter on every listener it owns.
--
-- Envoy carries the bytes: the CONNECT listener, TLS on both sides, the upstream pools, streaming.
-- This script makes every choice about a credential, and nothing else. It ships once per Instance
-- in the `jr2-held` ConfigMap (`program.lua`); each pod's own `custodian.lua` is a generated `HELD`
-- table (names, headers, paths, bound targets — never a value) that ends by loading this file.
-- Envoy loads that once per Lua state at start, so the top-level code below runs before any
-- listener serves, with `HELD` already set: a value that is missing or cannot ride a header stops
-- the start-up with a line that names the secret, never the value.
--
-- Four roles, one per route family, read from the route's metadata:
--
--   control    toward the Orchestrator, plain HTTP: the agent routes on the control socket, and
--              the ask on the loopback fetch listener (ADR-0076). Each listener has only its own
--              routes, so a route of the other one gets the deny route's 404
--   egress     the CONNECT listener: dial guard, then tunnel or hand to an intercept listener
--   intercept  one bound host, TLS already ended: swap the Stand-in, strip the rest
--   health     the kubelet's probe
--
-- The Custodian of an Instance (ADR-0084) runs this same program with one table for each slot, and
-- the table names the slot's own folder of values (`HELD.values`) and its Sandbox (`HELD.sandbox`).
-- Its listeners add three roles:
--
--   http       a Tunneled host's plain HTTP: the `Host` chose the route; the address must agree
--   refuse     a refusal that a route states (`reason`, `body`), so that each one is logged alike
--   inbound    the Orchestrator's dial to a Harness pod: the dial token, then the target check

local VALUES = HELD.values or "/etc/jr2/custodian/values/"

-- The value of one held secret, or its Stand-in, read once. One trailing line end is taken off,
-- because `kubectl create secret --from-file` writes one; anything else a header cannot carry stops
-- us. The line names the file, never what it holds.
local function load(name)
  local f = io.open(VALUES .. name, "rb")
  if f == nil then
    error("jr2.custodian refuse secret=" .. name .. " reason=missing-value")
  end
  local v = f:read("*a")
  f:close()
  v = v:gsub("\r?\n$", "", 1)
  if v == "" then
    error("jr2.custodian refuse secret=" .. name .. " reason=empty-value")
  end
  if v:find("[^\32-\126]") then
    error("jr2.custodian refuse secret=" .. name .. " reason=value-not-printable-ascii")
  end
  return v
end

-- Every Stand-in is secret but the fetch Stand-in (ADR-0059, ADR-0076): the pod's maker minted it,
-- and it is a value too, read from `<NAME>.standin` beside the secret's own. The one public Stand-in
-- rides the table (`standIn`), because `jr2-upload-pack` holds it as a constant.
local STAND_IN = {}
local VALUE = {}
for _, s in ipairs(HELD.secrets) do
  STAND_IN[s.name] = s.standIn or load(s.name .. ".standin")
  VALUE[s.name] = load(s.name)
end

-- The slot the Harness states on a control request (ADR-0076). It goes to the Orchestrator on a
-- control route, unchanged, and to no other host.
local SLOT_HEADER = "x-jr2-slot"

-- The headers every bound target treats as a credential (`CREDENTIAL_HEADERS`, held-secrets.ts).
local CREDENTIAL = {}
for _, h in ipairs(HELD.credential) do CREDENTIAL[h] = true end

-- Everything a target's requests may carry a credential in: the fixed set, plus every header a
-- secret bound to it names.
local function credentialHeaders(bound)
  local set = {}
  for h in pairs(CREDENTIAL) do set[h] = true end
  for _, s in ipairs(bound) do
    for _, h in ipairs(s.headers) do set[h] = true end
  end
  return set
end

local function tag(handle, key, value)
  handle:streamInfo():dynamicMetadata():set("jr2", key, value)
end

-- `mark`, when given, is the `x-jr2-custodian` header of the answer: the Orchestrator's dial reads
-- it to tell the Custodian's own refusal from a Harness pod's answer (ADR-0084). `extra` adds
-- headers to the answer (the 401's `www-authenticate`).
local function refuse(handle, status, reason, body, mark, extra)
  tag(handle, "action", "refuse")
  tag(handle, "reason", reason)
  tag(handle, "log", true)
  local headers = { [":status"] = tostring(status), ["content-type"] = "text/plain" }
  if mark ~= nil then headers["x-jr2-custodian"] = mark end
  for k, v in pairs(extra or {}) do headers[k] = v end
  handle:respond(headers, "jr2 custodian: " .. body .. "\n")
end

-- Base64 of RFC 4648, the standard alphabet, padded: what a Basic header holds. Arithmetic only,
-- so it needs no library of the Lua state.
local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local B64_INDEX = {}
for i = 1, 64 do B64_INDEX[B64:sub(i, i)] = i - 1 end

local function b64encode(s)
  local out = {}
  for i = 1, #s, 3 do
    local a, b, c = s:byte(i, i + 2)
    local n = a * 65536 + (b or 0) * 256 + (c or 0)
    local q = { math.floor(n / 262144) % 64, math.floor(n / 4096) % 64, math.floor(n / 64) % 64, n % 64 }
    out[#out + 1] = B64:sub(q[1] + 1, q[1] + 1) .. B64:sub(q[2] + 1, q[2] + 1) ..
      (b == nil and "=" or B64:sub(q[3] + 1, q[3] + 1)) .. (c == nil and "=" or B64:sub(q[4] + 1, q[4] + 1))
  end
  return table.concat(out)
end

-- The bytes of a padded base64 text, or nil when it is not one.
local function b64decode(s)
  if #s == 0 or #s % 4 ~= 0 or not s:match("^[A-Za-z0-9+/]+=?=?$") then return nil end
  local out = {}
  for i = 1, #s, 4 do
    local chunk = s:sub(i, i + 3)
    local pad = select(2, chunk:gsub("=", ""))
    local n = 0
    for j = 1, 4 do n = n * 64 + (B64_INDEX[chunk:sub(j, j)] or 0) end
    local bytes = string.char(math.floor(n / 65536) % 256, math.floor(n / 256) % 256, n % 256)
    out[#out + 1] = bytes:sub(1, 3 - pad)
  end
  return table.concat(out)
end

-- The swap, in the three forms a client writes a key in: the Stand-in alone (`x-api-key`), one auth
-- scheme then the Stand-in (`Authorization: Bearer`), or a Basic pair whose password is the
-- Stand-in (git's token push, ADR-0068): the pair is decoded, its password becomes the value, and it
-- is encoded again. Nothing else is ever rewritten.
--
-- For a secret that rides Basic, a pair whose password is already the value is carried as it is:
-- the bound host handed it back, as an LFS server puts the batch request's pair into its upload and
-- verify actions, and git-lfs sends an action's header as given (ADR-0059). It goes only to this
-- host, because the caller is a request toward a target this secret is bound to.
local function swapped(value, standIn, secret, basic)
  if value == standIn then return secret end
  local scheme, rest = value:match("^([A-Za-z][A-Za-z0-9._~+/-]*) (.+)$")
  if scheme ~= nil and rest == standIn then return scheme .. " " .. secret end
  if scheme ~= nil and scheme:lower() == "basic" then
    local pair = b64decode(rest)
    local user, password = (pair or ""):match("^([^:]*):(.*)$")
    if password ~= nil and password == standIn then return scheme .. " " .. b64encode(user .. ":" .. secret) end
    if basic and password ~= nil and secret ~= nil and password == secret then return value end
  end
  return nil
end

-- One request toward a target whose secrets are `bound`: every credential header is either the
-- product of a swap or gone, and a request that swapped nothing never leaves, unless the target is
-- `open`: an Intercepted host that no secret is bound to, or a bound host that the Egress list also
-- names (ADR-0084). Such a request leaves with every credential header removed.
--
-- A request that carries no credential header at all, to a target that is not open and whose
-- secret rides Basic, gets 401 with `WWW-Authenticate: Basic`: git sends no credential before a
-- 401, and only then asks its helper for the Stand-in (ADR-0059).
local function hold(handle, headers, bound, target, path, open)
  local creds = credentialHeaders(bound)
  local sent = false
  for h in pairs(creds) do
    if headers:getNumValues(h) > 1 then
      return refuse(handle, 400, "credential", target .. " got header " .. h .. " more than once")
    end
    if headers:get(h) ~= nil then sent = true end
  end
  local done = {}
  local names = {}
  for _, s in ipairs(bound) do
    for _, h in ipairs(s.headers) do
      local v = headers:get(h)
      if v ~= nil and not done[h] then
        local out = swapped(v, STAND_IN[s.name], VALUE[s.name], s.basic)
        if out ~= nil then
          if s.paths ~= nil then
            local allowed = false
            for _, p in ipairs(s.paths) do
              if path == p or path:sub(1, #p) == p and (p:sub(-1) == "/" or path:sub(#p + 1, #p + 1) == "/") then
                allowed = true
              end
            end
            if not allowed then
              return refuse(handle, 403, "path", s.name .. " may not be sent to this path of " .. target)
            end
          end
          headers:replace(h, out)
          done[h] = true
          names[#names + 1] = s.name
        end
      end
    end
  end
  for h in pairs(creds) do
    if not done[h] then headers:remove(h) end
  end
  if #names == 0 and open then
    tag(handle, "action", "intercept")
    tag(handle, "secret", "")
    tag(handle, "log", true)
    return
  end
  if #names == 0 and not sent then
    for _, s in ipairs(bound) do
      if s.basic then
        return refuse(handle, 401, "basic", target .. " needs a credential", nil,
          { ["www-authenticate"] = 'Basic realm="jr2"' })
      end
    end
  end
  if #names == 0 then
    local wanted, where = {}, {}
    for _, s in ipairs(bound) do
      wanted[#wanted + 1] = s.name
      for _, h in ipairs(s.headers) do where[#where + 1] = h end
    end
    return refuse(handle, 403, "stand-in", target .. " needs the stand-in of " .. table.concat(wanted, ", ") ..
      " in " .. table.concat(where, ", "))
  end
  tag(handle, "action", "intercept")
  tag(handle, "secret", table.concat(names, ","))
  tag(handle, "log", true)
end

-- A CONNECT target, one spelling: lowercase, no trailing dot on the name.
local function normal(authority)
  local a = authority:lower()
  local host, port = a:match("^(%[[^%]]+%]):(%d+)$")
  if host == nil then host, port = a:match("^([^:]+):(%d+)$") end
  if host == nil then return nil end
  host = host:gsub("%.$", "")
  return host, port
end

local function ipv4(host)
  local a, b, c, d = host:match("^(%d+)%.(%d+)%.(%d+)%.(%d+)$")
  if a == nil then return nil end
  a, b, c, d = tonumber(a), tonumber(b), tonumber(c), tonumber(d)
  if a > 255 or b > 255 or c > 255 or d > 255 then return nil end
  return a, b, c, d
end

-- An IPv6 literal as eight numbers, or nil.
local function ipv6(host)
  local s = host:match("^%[(.+)%]$")
  if s == nil or not s:find(":") then return nil end
  local v4 = s:match(":(%d+%.%d+%.%d+%.%d+)$")
  if v4 ~= nil then
    local a, b, c, d = ipv4(v4)
    if a == nil then return nil end
    s = s:sub(1, #s - #v4) .. string.format("%x:%x", a * 256 + b, c * 256 + d)
  end
  local head, rest = s:match("^(.-)::(.*)$")
  local function groups(part)
    local out = {}
    if part == "" then return out end
    for g in (part .. ":"):gmatch("([^:]*):") do
      if not g:match("^%x%x?%x?%x?$") then return nil end
      out[#out + 1] = tonumber(g, 16)
    end
    return out
  end
  local left, right
  if head == nil then
    left, right = groups(s), {}
    if left == nil or #left ~= 8 then return nil end
  else
    left, right = groups(head), groups(rest)
    if left == nil or right == nil or #left + #right > 7 then return nil end
  end
  local out = {}
  for _, g in ipairs(left) do out[#out + 1] = g end
  for _ = 1, 8 - #left - #right do out[#out + 1] = 0 end
  for _, g in ipairs(right) do out[#out + 1] = g end
  return out
end

-- The dial guard's first half: a tunnel never reaches loopback, link-local (the cloud metadata
-- address among it), or an unspecified address — nor an IPv4-mapped spelling of one. By NAME it
-- knows only `localhost`. The second half is Envoy's: an RBAC filter judges the address the
-- dynamic forward proxy resolved a name to, and `envoy_on_response` logs its refusal (ADR-0059).
local function guarded(host)
  if host == "localhost" or host:sub(-10) == ".localhost" then return true end
  local a, b = ipv4(host)
  if a ~= nil then
    return a == 127 or a == 0 or (a == 169 and b == 254)
  end
  local g = ipv6(host)
  if g ~= nil then
    local zero = true
    for i = 1, 7 do if g[i] ~= 0 then zero = false end end
    if zero and (g[8] == 0 or g[8] == 1) then return true end
    if g[1] >= 0xfe80 and g[1] <= 0xfebf then return true end
    if g[1] == 0xfd00 and g[2] == 0xec2 and g[3] == 0 and g[4] == 0 and g[5] == 0 and g[6] == 0 and g[7] == 0
      and g[8] == 0x254 then return true end
    local mapped = g[1] == 0 and g[2] == 0 and g[3] == 0 and g[4] == 0 and g[5] == 0 and g[6] == 0xffff
    if mapped then
      local x, y = math.floor(g[7] / 256), g[7] % 256
      return x == 127 or x == 0 or (x == 169 and y == 254)
    end
  end
  return false
end

local function egress(handle, headers)
  if headers:get(":method") ~= "CONNECT" then
    return refuse(handle, 405, "method", "this listener speaks CONNECT alone")
  end
  local authority = headers:get(":authority") or ""
  local host, port = normal(authority)
  if host == nil then
    return refuse(handle, 400, "target", "a CONNECT names host:port")
  end
  local target = host .. ":" .. port
  if target ~= authority then
    headers:replace(":authority", target)
    handle:clearRouteCache()
  end
  if HELD.targets[target] ~= nil then
    -- Handed to the intercept listener, which logs each request it carries.
    return
  end
  if guarded(host) then
    return refuse(handle, 403, "guard", target .. " is loopback, link-local or unspecified")
  end
  tag(handle, "action", "tunnel")
  tag(handle, "log", true)
end

-- What a bound host is sent. TRACE is not: a server that answers it echoes the request, the
-- swapped value among it, back to the Agent. Neither is a WebDAV or other extension method.
local METHODS = { GET = true, HEAD = true, POST = true, PUT = true, PATCH = true, DELETE = true, OPTIONS = true }

local function intercept(handle, headers, target)
  if not METHODS[headers:get(":method")] then
    return refuse(handle, 405, "method", target .. " takes GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS here")
  end
  if headers:get("upgrade") ~= nil then
    return refuse(handle, 501, "upgrade", target .. " takes no protocol upgrade here")
  end
  local host = (headers:get(":authority") or ""):lower()
  local want = target
  if target:sub(-4) == ":443" then
    if host == target:sub(1, -5) then host = target end
  elseif target:sub(-3) == ":80" then
    if host == target:sub(1, -4) then host = target end
  end
  if host ~= want then
    return refuse(handle, 421, "host", "Host does not name " .. target)
  end
  local path = (headers:get(":path") or "/"):match("^[^?]*")
  if path:lower():find("%%2[ef]") then
    return refuse(handle, 400, "path", "an encoded / or . in the path")
  end
  for _, h in ipairs({ "te", "trailer", "keep-alive", "proxy-connection", SLOT_HEADER }) do headers:remove(h) end
  local open = HELD.open ~= nil and HELD.open[target] == true
  return hold(handle, headers, HELD.targets[target] or {}, target, path, open)
end

local function control(handle, headers, route)
  if route == "fetch" then
    -- A slot's table names its Sandbox (ADR-0084): the uplink chose the slot, so the Harness pod
    -- that sent the connection chose nothing. A table with no slot is the in-pod Custodian's.
    local sandbox = HELD.sandbox
    if HELD.slot == nil then sandbox = os.getenv("JR2_SANDBOX") end
    if sandbox == nil or sandbox == "" then
      tag(handle, "action", "refuse")
      tag(handle, "reason", "no-sandbox")
      tag(handle, "log", true)
      return handle:respond({ [":status"] = "404", ["content-type"] = "application/json" },
        '{"error":"this pod serves no Sandbox, so it mounts no Repo to fetch (ADR-0053)"}')
    end
    headers:replace(":path", "/sandboxes/" .. sandbox .. "/fetch")
    -- The fetch acts for the Sandbox, not for an Agent: no slot rides it.
    headers:remove(SLOT_HEADER)
  end
  return hold(handle, headers, HELD.control, "orchestrator", headers:get(":path"))
end

-- The Orchestrator's dial to a Harness pod (ADR-0084): it names the pod by `x-jr2-target`, and it
-- proves that it is the Orchestrator by `x-jr2-dial`, the dial token of this Instance. The token is
-- read from its file at each dial: the Custodian's control process writes the file after Envoy
-- starts, and again when the Instance's token changes, and its own API takes the token of the same
-- file. One trailing `\n` or `\r\n` is taken off, as the control process does (`dialTokenOf`).
-- Neither header leaves the Custodian.
local DIAL_HEADER = "x-jr2-dial"
local TARGET_HEADER = "x-jr2-target"

local function dial_token()
  local f = io.open(HELD.inbound.token, "rb")
  if f == nil then return nil end
  -- A folder opens, and reads as nil.
  local v = f:read("*a")
  f:close()
  if v == nil then return nil end
  v = v:gsub("\r?\n$", "", 1)
  if v == "" then return nil end
  return v
end

local function inbound(handle, headers)
  local token = dial_token()
  local given = headers:get(DIAL_HEADER)
  local count = headers:getNumValues(DIAL_HEADER)
  headers:remove(DIAL_HEADER)
  if token == nil then
    return refuse(handle, 503, "not-ready", "the Custodian has no dial token yet", "not-ready")
  end
  if count ~= 1 or given ~= token then
    return refuse(handle, 403, "dial", "a dial to a Harness pod needs the dial token of this Instance", "refused")
  end
  local target = headers:get(TARGET_HEADER)
  if headers:getNumValues(TARGET_HEADER) ~= 1 or HELD.inbound.targets[target] ~= true then
    return refuse(handle, 403, "target", "the target is not port 8080 or 8082 of a slot of this Instance", "refused")
  end
  tag(handle, "action", "inbound")
  tag(handle, "target", target)
  tag(handle, "log", true)
end

local READY = false

-- A refusal by resolved address comes from the RBAC filter after this one: the one 403 a request
-- this script let through as a tunnel can get. It is logged as a refusal by spelling is. (A slot's
-- chains dial through the Custodian's dial listeners, which log the guard's refusal themselves.)
function envoy_on_response(handle)
  if handle:metadata():get("role") ~= "egress" then return end
  if handle:headers():get(":status") ~= "403" then return end
  local jr2 = handle:streamInfo():dynamicMetadata():get("jr2")
  if jr2 == nil or jr2.action ~= "tunnel" then return end
  tag(handle, "action", "refuse")
  tag(handle, "reason", "guard")
end

local function decide(handle, meta, role)
  local headers = handle:headers()
  if role == "egress" then return egress(handle, headers) end
  if role == "intercept" then return intercept(handle, headers, meta:get("target")) end
  if role == "control" then return control(handle, headers, meta:get("route")) end
  if role == "inbound" then return inbound(handle, headers) end
  if role == "http" then
    -- One HTTP chain serves port 80 of each Tunneled name of the slot: the `Host` chose the route,
    -- and the address dialed must be that host's placeholder (ADR-0084).
    local here = handle:streamInfo():downstreamLocalAddress()
    if here ~= meta:get("address") then
      return refuse(handle, 403, "host", "the Host header does not name the host of the address dialed")
    end
    for _, h in ipairs({ "proxy-connection", SLOT_HEADER }) do headers:remove(h) end
    tag(handle, "action", "tunnel")
    tag(handle, "log", true)
    return
  end
  if role == "refuse" then
    return refuse(handle, tonumber(meta:get("status")) or 403, meta:get("reason"), meta:get("body"))
  end
  if role == "health" then
    if not READY then
      READY = true
      local names = {}
      for _, s in ipairs(HELD.secrets) do names[#names + 1] = s.name end
      io.stdout:write("jr2.custodian ready secrets=" .. table.concat(names, ",") .. " hosts=" .. HELD.hosts .. "\n")
      io.stdout:flush()
    end
    return handle:respond({ [":status"] = "200", ["content-type"] = "text/plain" }, "ok\n")
  end
  if role == "deny" then
    return refuse(handle, 404, "route", "no such route")
  end
end

-- Envoy's Lua filter lets a request go on when the script raises, and then no check of this
-- program has run. So each request is decided in a protected call, and an error refuses it: the
-- Custodian fails closed. The line names the role, never what the request held.
function envoy_on_request(handle)
  local meta = handle:metadata()
  local role = meta:get("role")
  local ok, err = pcall(decide, handle, meta, role)
  if not ok then
    handle:logErr("jr2.custodian refuse reason=error role=" .. tostring(role) .. ": " .. tostring(err))
    local mark = nil
    if role == "inbound" then mark = "refused" end
    return refuse(handle, 503, "error", "the Custodian could not decide this request", mark)
  end
end
