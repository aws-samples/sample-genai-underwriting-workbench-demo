import json
import os
import boto3
import urllib.parse
import tempfile
from pdf2image import pdfinfo_from_path

s3 = boto3.client('s3')
BATCH_SIZE = int(os.environ.get('BATCH_SIZE', '1'))

def handler(event, context):
    # --- 1) Normalize bucket name ---
    raw_bucket = event.get('detail', {}).get('bucket')
    if isinstance(raw_bucket, dict):
        bucket = raw_bucket.get('name')
    else:
        bucket = raw_bucket

    # --- 2) Normalize object key ---
    raw_obj = event.get('detail', {}).get('object')
    if isinstance(raw_obj, dict):
        key = raw_obj.get('key')
    else:
        key = raw_obj

    if not bucket or not key:
        raise RuntimeError(f"Cannot find S3 bucket/key in event: {json.dumps(event)}")

    # URL‑decode just in case
    key = urllib.parse.unquote_plus(key)

    # Use a temp dir that’s auto‑cleaned at the end of the with‑block
    with tempfile.TemporaryDirectory(dir='/tmp') as tmpdir:
        # --- 3) Download PDF into temp dir ---
        local_filename = os.path.basename(key)
        local_path = os.path.join(tmpdir, local_filename)
        s3.download_file(bucket, key, local_path)

        # --- 4) Count pages ---
        info = pdfinfo_from_path(local_path)
        total_pages = int(info.get("Pages", 0))

        # --- 5) Build batchRanges ---
        batches = []
        p = 1
        while p <= total_pages:
            end = min(p + BATCH_SIZE - 1, total_pages)
            batches.append({"start": p, "end": end})
            p = end + 1

    # --- 6) Return to Step Functions ---
    return {"batchRanges": batches}
