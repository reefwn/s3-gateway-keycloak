FROM oven/bun:1.3.14-debian AS development

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

RUN groupadd --system app && useradd --system --gid app --create-home app
USER app

EXPOSE 3000

CMD ["bun", "dev"]
