-- The Custodian's decisions (ADR-0059), run by Envoy's Lua filter on every listener it owns.
--
-- Envoy carries the bytes: the CONNECT listener, TLS on both sides, the upstream pools, streaming.
-- This script makes every choice about a credential, and nothing else. `jr2 up` prepends a
-- generated `HELD` table (names, headers, paths, bound targets — never a value) and ships the
-- whole file in the `jr2-held` ConfigMap. Envoy loads it once per Lua state at start, so the
-- top-level code below runs before any listener serves: a value that is missing or cannot ride a
-- header stops the start-up with a line that names the secret, never the value.
--
-- Four roles, one per route family, read from the route's metadata:
--
--   control    the Harness's Menu and the ask, plain HTTP on loopback, toward the Orchestrator
--   egress     the CONNECT listener: dial guard, then tunnel or hand to an intercept listener
--   intercept  one bound host, TLS already ended: swap the Stand-in, strip the rest
--   health     the kubelet's probe

local VALUES = "/etc/jr2/custodian/values/"

-- The value of one held secret, read once. One trailing line end is taken off, because
-- `kubectl create secret --from-file` writes one; anything else a header cannot carry stops us.
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

local STAND_IN = {}
local VALUE = {}
for _, s in ipairs(HELD.secrets) do
  STAND_IN[s.name] = "jr2-held-" .. s.name
  VALUE[s.name] = load(s.name)
end

local CREDENTIAL = { ["authorization"] = true, ["x-api-key"] = true, ["x-goog-api-key"] = true,
  ["api-key"] = true, ["proxy-authorization"] = true }

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

local function refuse(handle, status, reason, body)
  tag(handle, "action", "refuse")
  tag(handle, "reason", reason)
  tag(handle, "log", true)
  handle:respond({ [":status"] = tostring(status), ["content-type"] = "text/plain" }, "jr2 custodian: " .. body .. "\n")
end

-- The swap, in the two forms a client writes a key in: the Stand-in alone (`x-api-key`), or one
-- auth scheme then the Stand-in (`Authorization: Bearer`). Nothing else is ever rewritten.
local function swapped(value, standIn, secret)
  if value == standIn then return secret end
  local scheme, rest = value:match("^([A-Za-z][A-Za-z0-9._~+/-]*) (.+)$")
  if scheme ~= nil and rest == standIn then return scheme .. " " .. secret end
  return nil
end

-- One request toward a target whose secrets are `bound`: every credential header is either the
-- product of a swap or gone, and a request that swapped nothing never leaves.
local function hold(handle, headers, bound, target, path)
  local creds = credentialHeaders(bound)
  for h in pairs(creds) do
    if headers:getNumValues(h) > 1 then
      return refuse(handle, 400, "credential", target .. " got header " .. h .. " more than once")
    end
  end
  local done = {}
  local names = {}
  for _, s in ipairs(bound) do
    for _, h in ipairs(s.headers) do
      local v = headers:get(h)
      if v ~= nil and not done[h] then
        local out = swapped(v, STAND_IN[s.name], VALUE[s.name])
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

-- The dial guard: a tunnel never reaches loopback, link-local (the cloud metadata address among
-- it), or an unspecified address — nor an IPv4-mapped spelling of one. By NAME it knows only
-- `localhost`: Envoy's dynamic forward proxy has no filter on the address a name resolves to, so a
-- name that resolves to one of these is the recorded gap (ADR-0059).
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

local function intercept(handle, headers, target)
  if headers:get("upgrade") ~= nil then
    return refuse(handle, 501, "upgrade", target .. " takes no protocol upgrade here")
  end
  local host = (headers:get(":authority") or ""):lower()
  local want = target
  if target:sub(-4) == ":443" then
    if host == target:sub(1, -5) then host = target end
  end
  if host ~= want then
    return refuse(handle, 421, "host", "Host does not name " .. target)
  end
  local path = (headers:get(":path") or "/"):match("^[^?]*")
  if path:lower():find("%%2[ef]") then
    return refuse(handle, 400, "path", "an encoded / or . in the path")
  end
  for _, h in ipairs({ "te", "trailer", "keep-alive", "proxy-connection" }) do headers:remove(h) end
  return hold(handle, headers, HELD.targets[target], target, path)
end

local function control(handle, headers, route)
  if route == "fetch" then
    local sandbox = os.getenv("JR2_SANDBOX")
    if sandbox == nil or sandbox == "" then
      tag(handle, "action", "refuse")
      tag(handle, "reason", "no-sandbox")
      tag(handle, "log", true)
      return handle:respond({ [":status"] = "404", ["content-type"] = "application/json" },
        '{"error":"this pod serves no Sandbox, so it mounts no Repo to fetch (ADR-0053)"}')
    end
    headers:replace(":path", "/sandboxes/" .. sandbox .. "/fetch")
  end
  return hold(handle, headers, HELD.control, "orchestrator", headers:get(":path"))
end

local READY = false

function envoy_on_request(handle)
  local meta = handle:metadata()
  local role = meta:get("role")
  local headers = handle:headers()
  if role == "egress" then return egress(handle, headers) end
  if role == "intercept" then return intercept(handle, headers, meta:get("target")) end
  if role == "control" then return control(handle, headers, meta:get("route")) end
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
