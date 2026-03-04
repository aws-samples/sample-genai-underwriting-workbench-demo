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
    assert 'French' in index.get_language_instruction('fr-FR')
    assert 'German' in index.get_language_instruction('de-DE')
    assert 'Italian' in index.get_language_instruction('it-IT')
    assert 'English' in index.get_language_instruction('unknown')

def test_validate_analysis_data_valid():
    """Test validation with valid data"""
    import index
    
    valid_data = {
        'overall_summary': 'Test summary',
        'identified_risks': [{'risk_description': 'Test', 'severity': 'High', 'page_references': ['1']}],
        'discrepancies': [],
        'medical_timeline': 'Timeline',
        'property_assessment': 'Assessment',
        'final_recommendation': 'Recommendation',
        'missing_information': [],
        'confidence_score': 0.85
    }
    
    assert index.validate_analysis_data(valid_data, index.ANALYSIS_OUTPUT_SCHEMA) == True

def test_validate_analysis_data_missing_keys():
    """Test validation with missing keys"""
    import index
    
    invalid_data = {
        'overall_summary': 'Test summary'
    }
    
    result = index.validate_analysis_data(invalid_data, index.ANALYSIS_OUTPUT_SCHEMA)
    
    # Should add missing keys with defaults
    assert 'identified_risks' in invalid_data
    assert 'discrepancies' in invalid_data
    assert isinstance(invalid_data['identified_risks'], list)

def test_validate_analysis_data_wrong_types():
    """Test validation with wrong data types"""
    import index
    
    invalid_data = {
        'overall_summary': 'Test',
        'identified_risks': 'should be list',  # Wrong type
        'discrepancies': [],
        'medical_timeline': 'Timeline',
        'property_assessment': 'Assessment',
        'final_recommendation': 'Recommendation',
        'missing_information': [],
        'confidence_score': 0.85
    }
    
    assert index.validate_analysis_data(invalid_data, index.ANALYSIS_OUTPUT_SCHEMA) == False

def test_analysis_output_schema_structure():
    """Test that analysis output schema has required fields"""
    import index
    
    schema = index.ANALYSIS_OUTPUT_SCHEMA
    
    assert 'overall_summary' in schema
    assert 'identified_risks' in schema
    assert 'discrepancies' in schema
    assert 'medical_timeline' in schema
    assert 'property_assessment' in schema
    assert 'final_recommendation' in schema
    assert 'missing_information' in schema
    assert 'confidence_score' in schema
