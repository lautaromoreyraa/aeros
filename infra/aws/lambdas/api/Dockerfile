FROM public.ecr.aws/lambda/python:3.12

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt --target "${LAMBDA_TASK_ROOT}"

# httpfs is fetched at build time: at run time /home is read-only and the
# function should not depend on reaching the DuckDB extension repository.
ENV DUCKDB_EXTENSION_DIRECTORY=/opt/duckdb_extensions
RUN PYTHONPATH="${LAMBDA_TASK_ROOT}" python -c "import duckdb; \
con = duckdb.connect(config={'extension_directory': '/opt/duckdb_extensions'}); \
con.install_extension('httpfs')"

COPY aeros_api/ ${LAMBDA_TASK_ROOT}/aeros_api/

CMD ["aeros_api.handler.handler"]
