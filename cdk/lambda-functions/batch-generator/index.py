import json
import os
import boto3
import urllib.parse
import tempfile
import time
import traceback
from pdf2image import pdfinfo_from_path

s3 = boto3.client('s3')
BATCH_SIZE = int(os.environ.get('BATCH_SIZE', '1'))

def log_timing(operation_name, start_time):
    """Log the duration of an operation"""
    elapsed = time.time() - start_time
    print(f"[TIMING] {operation_name} completed in {elapsed:.2f}s")

def handler(event, context):
    handler_start = time.time()
    print(f"[batch-generator] === BATCH GENERATOR LAMBDA START === remaining_time={context.get_remaining_time_in_millis()}ms")
    print(f"[batch-generator] Event keys: {list(event.keys()) if isinstance(event, dict) else 'not a dict'}")
    print(f"[batch-generator] Event size: {len(json.dumps(event))} bytes")
    print(f"[batch-generator] BATCH_SIZE={BATCH_SIZE}")
    
    # --- 1) Normalize bucket name ---
    print(f"[batch-generator] Step 1: Extracting S3 info, remaining_time={context.get_remaining_time_in_millis()}ms")
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
        print(f"[batch-generator] ERROR: Cannot find S3 bucket/key in event")
        raise RuntimeError(f"Cannot find S3 bucket/key in event: {json.dumps(event)}")

    # URL-decode just in case
    key = urllib.parse.unquote_plus(key)
    print(f"[batch-generator] bucket={bucket}, key={key}")

    # Use a temp dir that's auto-cleaned at the end of the with-block
    with tempfile.TemporaryDirectory(dir='/tmp') as tmpdir:
        # --- 3) Download PDF into temp dir ---
        print(f"[batch-generator] Step 2: Downloading PDF from S3, remaining_time={context.get_remaining_time_in_millis()}ms")
        local_filename = os.path.basename(key)
        local_path = os.path.join(tmpdir, local_filename)
        s3_download_start = time.time()
        try:
            s3.download_file(bucket, key, local_path)
            log_timing("S3 download", s3_download_start)
            file_size = os.path.getsize(local_path)
            print(f"[batch-generator] Downloaded PDF, size={file_size} bytes")
        except Exception as e:
            log_timing("S3 download (FAILED)", s3_download_start)
            print(f"[batch-generator] ERROR downloading from S3: {e}")
            traceback.print_exc()
            raise

        # --- 4) Count pages ---
        print(f"[batch-generator] Step 3: Reading PDF page count, remaining_time={context.get_remaining_time_in_millis()}ms")
        try:
            info = pdfinfo_from_path(local_path)
            total_pages = int(info.get("Pages", 0))
            print(f"[batch-generator] PDF has {total_pages} total pages")
        except Exception as e:
            print(f"[batch-generator] ERROR reading PDF info: {e}")
            traceback.print_exc()
            raise

        # --- 5) Build batchRanges ---
        print(f"[batch-generator] Step 4: Building batch ranges, remaining_time={context.get_remaining_time_in_millis()}ms")
        batches = []
        p = 1
        while p <= total_pages:
            end = min(p + BATCH_SIZE - 1, total_pages)
            batches.append({"start": p, "end": end})
            p = end + 1
        print(f"[batch-generator] Created {len(batches)} batches")

    # --- 6) Return to Step Functions ---
    log_timing("Total BATCH GENERATOR lambda execution", handler_start)
    print(f"[batch-generator] === BATCH GENERATOR LAMBDA COMPLETE === remaining_time={context.get_remaining_time_in_millis()}ms")
    result = {"batchRanges": batches}
    print(f"[batch-generator] Returning result: {json.dumps(result)}")
    return result
