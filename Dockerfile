# Static site — nothing to build, nginx serves the files as-is.
FROM nginx:1.27-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
COPY assets /usr/share/nginx/html/assets

EXPOSE 80
