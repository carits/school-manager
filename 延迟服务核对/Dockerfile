FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN SECRET_KEY=build DATA_KEY=build LOOKUP_KEY=build python manage.py collectstatic --noinput
RUN useradd --uid 10001 --create-home app
USER app
EXPOSE 8000
CMD ["gunicorn","config.wsgi:application","--bind","0.0.0.0:8000","--workers","2","--threads","4","--timeout","60"]
