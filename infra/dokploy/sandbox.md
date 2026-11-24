# Локальная песочница Dokploy

Для записи фикстур и контрактных тестов api. Dokploy ставится в привилегированный контейнер `docker:dind`
со своим Docker и Swarm: порты хоста 80/443/3000 не занимаются, наружу — только `127.0.0.1:53000`.
Контейнер привилегированный: это почти root на хосте, держать его запущенным без нужды не стоит.

```bash
docker run -d --privileged --name botyard-dokploy -p 127.0.0.1:53000:3000 \
  -v botyard-dokploy-docker:/var/lib/docker docker:28-dind
docker exec botyard-dokploy sh -c 'apk add -q curl bash && rm -f /.dockerenv'   # установщик отказывается работать при /.dockerenv
curl -sSL https://dokploy.com/install.sh -o /tmp/dokploy-install.sh
docker cp /tmp/dokploy-install.sh botyard-dokploy:/root/install.sh
docker exec -e ADVERTISE_ADDR=127.0.0.1 botyard-dokploy sh /root/install.sh
```

Через минуту — `http://127.0.0.1:53000`: администратор, затем API-ключ без лимита (см. README.md рядом).

Контракт api с живым Dokploy:

```bash
cd api && DOKPLOY_TEST_URL=http://127.0.0.1:53000 DOKPLOY_TEST_API_KEY=<ключ> bun run test:contract
```

Удаление: `docker rm -f botyard-dokploy && docker volume rm botyard-dokploy-docker`.
