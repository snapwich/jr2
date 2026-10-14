mkdir -p ~/local-model-certs certs
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=local model CA" \
  -keyout ~/local-model-certs/ca.key -out ~/local-model-certs/ca.crt
openssl req -newkey rsa:2048 -nodes -subj "/CN=<address>" \
  -keyout ~/local-model-certs/server.key -out ~/local-model-certs/server.csr
printf "subjectAltName=IP:<address>\nextendedKeyUsage=serverAuth\n" > ~/local-model-certs/ext.cnf
openssl x509 -req -in ~/local-model-certs/server.csr -CA ~/local-model-certs/ca.crt \
  -CAkey ~/local-model-certs/ca.key -CAcreateserial -days 365 \
  -extfile ~/local-model-certs/ext.cnf -out ~/local-model-certs/server.crt
cp ~/local-model-certs/ca.crt certs/ca.crt
