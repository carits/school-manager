FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt .
COPY wheelhouse /wheels
RUN if ls /wheels/*.whl >/dev/null 2>&1; then pip install --no-index --find-links=/wheels -r requirements.txt; else pip install --timeout 120 -r requirements.txt; fi \
    && rm -rf /wheels && useradd --uid 10001 --create-home app
COPY . .
RUN SECRET_KEY=build-only DATA_KEY=build-only LOOKUP_KEY=build-only python manage.py collectstatic --noinput
USER app
EXPOSE 8000
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "2", "--threads", "4", "--timeout", "60", "--max-requests", "1000", "--max-requests-jitter", "100", "--error-logfile", "-"]
