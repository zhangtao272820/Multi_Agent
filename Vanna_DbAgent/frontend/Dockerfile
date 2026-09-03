FROM docker.1ms.run/library/nginx:1.27-alpine
COPY frontend/index.html /usr/share/nginx/html/index.html
COPY frontend/db-workbench.png /usr/share/nginx/html/db-workbench.png
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
