# context = repo root（見 docker-compose.yml）
FROM python:3.11-slim

# lightgbm 需要 libgomp
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
  && rm -rf /var/lib/apt/lists/*

# 非 root 執行：uid/gid 10001，無登入 shell、無家目錄寫入需求
RUN groupadd --system --gid 10001 appuser \
  && useradd --system --uid 10001 --gid appuser --create-home appuser

# /app 目錄本身也要屬於 appuser：train.py 會把 model.joblib 寫進 /app，
# 只 COPY --chown 的話目錄仍是 root，非 root 寫入會 EACCES。
RUN mkdir -p /app && chown appuser:appuser /app
WORKDIR /app

COPY --chown=appuser:appuser packages/ai-service/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=appuser:appuser packages/ai-service/ ./

USER appuser

# 建置時訓練模型（合成資料，seed 固定），讓容器啟動即可服務
RUN python train.py

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
