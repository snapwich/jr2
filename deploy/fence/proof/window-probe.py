#!/usr/bin/env python3
"""The window probe of the M1 proof (ADR-0084).

It runs as the first container of a Sandbox pod (a native sidecar), from the first instant of each new pod sandbox,
and every 100 ms it tries targets off the Fence. It sorts each answer:
  GW    the Custodian answered (its refusal text, its TLS alert, its resolver's NXDOMAIN)
  NONE  nothing answered
  LEAK  anything else answered
It prints one line for each round that differs from the round before, and each LEAK line at once.
"""
import os
import socket
import struct
import sys
import time

START = time.monotonic()
NODE_IP = os.environ.get("NODE_IP", "")
API_IP = os.environ.get("API_IP", "")
TCP_TARGETS = [("api-svc", "10.96.0.1", 443), ("one-one", "1.1.1.1", 80)]
if NODE_IP:
    TCP_TARGETS.append(("kubelet", NODE_IP, 10250))
if API_IP:
    TCP_TARGETS.append(("apiserver", API_IP, 6443))


def ms():
    return int((time.monotonic() - START) * 1000)


def tcp(addr, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.3)
    try:
        s.connect((addr, port))
        s.sendall(b"GET / HTTP/1.0\r\nHost: probe\r\n\r\n")
        data = s.recv(256)
    except OSError:
        return "NONE"
    finally:
        s.close()
    if not data:
        return "NONE"
    if data.startswith(b"jr2 custodian") or data[:2] == b"\x15\x03":
        return "GW"
    return "LEAK:" + repr(data[:40])


def dns_query(name):
    qid = os.getpid() & 0xFFFF
    q = struct.pack(">HHHHHH", qid, 0x0100, 1, 0, 0, 0)
    for label in name.split("."):
        q += bytes([len(label)]) + label.encode()
    return q + b"\x00" + struct.pack(">HH", 1, 1)


def dns(addr):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(0.3)
    try:
        s.sendto(dns_query("kubernetes.default.svc.cluster.local"), (addr, 53))
        data = s.recv(512)
    except OSError:
        return "NONE"
    finally:
        s.close()
    flags, ancount = struct.unpack(">H", data[2:4])[0], struct.unpack(">H", data[6:8])[0]
    if flags & 0xF == 3 and ancount == 0 and b"\x09custodian\x03jr2\x08internal" in data:
        return "GW"
    return "LEAK:dns rcode=%d answers=%d" % (flags & 0xF, ancount)


def udp(addr, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(0.3)
    try:
        s.sendto(b"\x1b" + 47 * b"\x00", (addr, port))
        data = s.recv(512)
    except OSError:
        return "NONE"
    finally:
        s.close()
    return "LEAK:udp " + repr(data[:20])


def main():
    print("window-probe start pid=%d node=%s" % (os.getpid(), NODE_IP), flush=True)
    last = None
    first_gw = None
    while True:
        row = [(n, tcp(a, p)) for n, a, p in TCP_TARGETS]
        row.append(("cluster-dns", dns("10.96.0.10")))
        row.append(("ntp", udp("8.8.8.8", 123)))
        line = " ".join("%s=%s" % kv for kv in row)
        if first_gw is None and any(v == "GW" for _, v in row):
            first_gw = ms()
            print("t=%d first-gw" % first_gw, flush=True)
        if "LEAK" in line:
            print("t=%d LEAK %s" % (ms(), line), flush=True)
        elif line != last:
            print("t=%d %s" % (ms(), line), flush=True)
        last = line
        time.sleep(0.1)


if __name__ == "__main__":
    sys.exit(main())
