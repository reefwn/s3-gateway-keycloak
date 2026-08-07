FROM oven/bun:1.3.14-debian AS development

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

RUN groupadd --system app && useradd --system --gid app --create-home app
USER app

EXPOSE 3000

CMD ["bun", "dev"]

FROM oven/bun:1.3.14-debian AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
ENV APP_ENVIRONMENT=deployment \
    DATABASE_URL=postgres://build:build@localhost:5432/build \
    NEXTAUTH_SECRET=build-only-nextauth-secret-with-32-characters \
    NEXTAUTH_URL=https://s3-browser.build.invalid \
    KEYCLOAK_ISSUER=https://keycloak.build.invalid/realms/internal \
    KEYCLOAK_CLIENT_ID=s3-browser-build \
    KEYCLOAK_CLIENT_SECRET=build-only-keycloak-client-secret \
    S3_REGION=ap-southeast-7 \
    S3_ALLOWED_BUCKETS=build-bucket \
    S3_ROLE_CLAIM=resource_access.s3-browser.roles \
    S3_ROLE_MAPPING="{\"s3-browser-build-admin\":\"admin\"}"
RUN bun run build

FROM oven/bun:1.3.14-debian AS production

WORKDIR /app

ENV NODE_ENV=production

RUN groupadd --system app && useradd --system --gid app --create-home app

COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json /app/drizzle.config.ts ./
COPY --from=build --chown=app:app /app/db ./db

USER app

EXPOSE 3000

CMD ["bun", "server.js"]
