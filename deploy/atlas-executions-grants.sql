-- Executar no banco Atlas, com -v reader=<papel dedicado já criado>.
BEGIN;
GRANT USAGE ON SCHEMA public TO :"reader";
GRANT SELECT (id, collector_name, started_at, finished_at, status, items_found, error_message, metrics, parameters)
  ON public.collector_run TO :"reader";
GRANT SELECT (total_tokens, input_chunk_ids, status, expected_schema_version)
  ON public.ai_run TO :"reader";
GRANT SELECT (status) ON public.extracted_fact TO :"reader";
GRANT SELECT (id, status) ON public.document_chunk TO :"reader";
COMMIT;
