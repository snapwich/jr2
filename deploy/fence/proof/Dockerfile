# The image of the M1 proof (ADR-0084): the uplink's init container (iproute2, nftables) and the vantage containers
# of deploy/fence/check.sh (curl, dig, nc, openssl, arping, python3). Built and loaded by deploy/fence/proof/up.sh.
# It is a test image of this repo only, and it goes with deploy/fence/proof/.
FROM alpine:3.22
RUN apk add --no-cache bash iproute2 nftables curl bind-tools netcat-openbsd openssl iputils-arping iputils-ping \
      python3 tcpdump coreutils
COPY window-probe.py /opt/fence/window-probe.py
