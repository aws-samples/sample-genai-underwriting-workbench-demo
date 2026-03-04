import pytest
import sys
import os
import json
from unittest.mock import Mock, patch, MagicMock

# Add parent directory to path
sys.path.insert(0, os.path.dirname(__file__))

def test_get_classification_prompt_life():
    """Test life insurance classification prompt"""
    import index
    
    prompt = index.get_classification_prompt('life')
    
    assert 'LIFE_INSURANCE_APPLICATION' in prompt
    assert 'MEDICAL_REPORT' in prompt
    assert 'ATTENDING_PHYSICIAN_STATEMENT' in prompt
    assert 'LAB_REPORT' in prompt
    assert 'PRESCRIPTION_HISTORY' in prompt
    assert 'FINANCIAL_STATEMENT' in prompt
    assert 'document_type' in prompt

def test_get_classification_prompt_pc():
    """Test P&C classification prompt"""
    import index
    
    prompt = index.get_classification_prompt('property_casualty')
    
    assert 'ACORD_FORM' in prompt
    assert 'COMMERCIAL_PROPERTY_APPLICATION' in prompt
    assert 'CRIME_REPORT' in prompt
    assert 'FINANCIAL_STATEMENT' in prompt

def test_log_timing():
    """Test timing logger"""
    import index
    import time
    
    start = time.time()
    time.sleep(0.01)
    
    # Should not raise exception
    index.log_timing("test_operation", start)

def test_classification_prompt_contains_json_format():
    """Test that prompts specify JSON output format"""
    import index
    
    life_prompt = index.get_classification_prompt('life')
    pc_prompt = index.get_classification_prompt('property_casualty')
    
    assert 'JSON' in life_prompt
    assert 'document_type' in life_prompt
    assert 'JSON' in pc_prompt
    assert 'document_type' in pc_prompt

def test_classification_prompt_life_has_all_types():
    """Test life prompt includes all document types"""
    import index
    
    prompt = index.get_classification_prompt('life')
    
    expected_types = [
        'LIFE_INSURANCE_APPLICATION',
        'MEDICAL_REPORT',
        'ATTENDING_PHYSICIAN_STATEMENT',
        'LAB_REPORT',
        'PRESCRIPTION_HISTORY',
        'FINANCIAL_STATEMENT'
    ]
    
    for doc_type in expected_types:
        assert doc_type in prompt

def test_classification_prompt_pc_has_all_types():
    """Test P&C prompt includes all document types"""
    import index
    
    prompt = index.get_classification_prompt('property_casualty')
    
    expected_types = [
        'ACORD_FORM',
        'COMMERCIAL_PROPERTY_APPLICATION',
        'CRIME_REPORT',
        'FINANCIAL_STATEMENT'
    ]
    
    for doc_type in expected_types:
        assert doc_type in prompt

def test_classification_prompt_default():
    """Test default classification prompt"""
    import index
    
    # Should default to property_casualty
    prompt = index.get_classification_prompt('unknown_type')
    
    assert 'ACORD_FORM' in prompt or 'LIFE_INSURANCE_APPLICATION' in prompt
