FROM node:15 as jsbuilder

COPY . /app
WORKDIR /app

RUN npm install

# ---------------------------------------------------------

FROM node:15-slim

COPY --from=jsbuilder /app /app

WORKDIR /app

EXPOSE 3000
ENTRYPOINT [ "node", "--experimental-json-modules", "index.js" ]
