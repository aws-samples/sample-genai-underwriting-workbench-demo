import pytest
import json
import sys
import os
from unittest.mock import Mock, patch, MagicMock

# Add parent directory to path
sys.path.insert(0, os.path.dirname(__file__))

def test_get_language_instruction():
    """Test language instruction generation"""
    import index
    
    assert 'English' in index.get_language_instruction('en-US')
    assert 'Chinese' in index.get_language_instruction('zh-CN')
    assert 'Japanese' in index.get_language_instruction('ja-JP')
    assert 'Spanish' in index.get_language_instruction('es-ES')

def test_log_timing():
    """Test timing logger"""
    import index
    import time
    
    start = time.time()
    time.sleep(0.01)
    
    # Should not raise exception
    index.log_timing("test_operation", start)

def test_extract_job_id_from_classification():
    """Test job ID extraction from classification"""
    import index
    
    event = {
        'classification': {
            'jobId': 'job-123'
        }
    }
    
    assert index._extract_job_id(event) == 'job-123'

def test_extract_job_id_fallback():
    """Test job ID extraction fallback"""
    import index
    
    event = {
        'jobId': 'job-456'
    }
    
    assert index._extract_job_id(event) == 'job-456'

def test_extract_job_id_none():
    """Test job ID extraction with no ID"""
    import index
    
    event = {}
    
    assert index._extract_job_id(event) is None

def test_get_impairments_payload_empty():
    """Test impairments payload with empty event"""
    import index
    
    event = {}
    
    result = index._get_impairments_payload(event)
    
    assert isinstance(result, list)
    assert len(result) == 0

def test_get_impairments_payload_with_detection():
    """Test impairments payload with detection output"""
    import index
    
    event = {
        'detection': {
            'impairments': [
                {
                    'impairment_id': 'imp-1',
                    'condition': 'Hypertension',
                    'severity': 'Moderate'
                }
            ]
        }
    }
    
    result = index._get_impairments_payload(event)
    
    assert isinstance(result, list)
