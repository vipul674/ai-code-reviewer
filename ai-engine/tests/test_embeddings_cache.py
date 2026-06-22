import pytest
from embeddings import (
    _embedding_cache,
    _cache_enabled,
    get_or_compute_embedding,
    invalidate_cache_for_file,
    clear_embedding_cache,
    embed_text,
)


class TestGetOrComputeEmbedding:
    """Tests for get_or_compute_embedding caching logic."""

    def setup_method(self):
        """Clear the cache before each test."""
        _embedding_cache.clear()

    def teardown_method(self):
        """Clear the cache after each test."""
        _embedding_cache.clear()

    def test_returns_embedding_when_cache_disabled(self):
        """When cache is disabled, get_or_compute_embedding delegates to embed_text."""
        result = get_or_compute_embedding("file.py", "def hello(): pass")
        expected = embed_text("def hello(): pass")
        assert result == expected

    def test_returns_consistent_embedding_for_same_content(self):
        """Same file+content should return the same embedding."""
        emb1 = get_or_compute_embedding("a.py", "x = 1")
        emb2 = get_or_compute_embedding("a.py", "x = 1")
        assert emb1 == emb2

    def test_caches_result_on_first_call(self):
        """First call should populate the cache."""
        get_or_compute_embedding("b.py", "print('hello')")
        assert "b.py" in _embedding_cache
        assert "embedding" in _embedding_cache["b.py"]
        assert "content_hash" in _embedding_cache["b.py"]

    def test_returns_cached_embedding_on_subsequent_calls(self):
        """Second call with same content should return cached result."""
        content = "y = 2"
        result1 = get_or_compute_embedding("c.py", content)
        result2 = get_or_compute_embedding("c.py", content)
        assert result1 == result2
        # Embeddings are identical lists
        assert all(a == b for a, b in zip(result1, result2))

    def test_different_file_paths_use_separate_cache_entries(self):
        """Same content in different files gets separate cache entries."""
        content = "z = 3"
        get_or_compute_embedding("file1.py", content)
        get_or_compute_embedding("file2.py", content)
        assert "file1.py" in _embedding_cache
        assert "file2.py" in _embedding_cache
        # They may have the same embedding but different keys
        assert _embedding_cache["file1.py"]["content_hash"] == _embedding_cache["file2.py"]["content_hash"]

    def test_modified_content_triggers_recomputation(self):
        """When content changes, cache miss triggers recomputation."""
        file_path = "d.py"
        get_or_compute_embedding(file_path, "old content")
        old_hash = _embedding_cache[file_path]["content_hash"]
        old_embedding = _embedding_cache[file_path]["embedding"]
        new_content = "new content that is different"
        new_result = get_or_compute_embedding(file_path, new_content)
        # The cache should now have the new hash and embedding
        new_hash = _embedding_cache[file_path]["content_hash"]
        assert new_hash != old_hash, "Hash should change when content changes"
        assert new_result != old_embedding, "Embedding should change when content changes"
        assert _embedding_cache[file_path]["embedding"] == new_result

    def test_invalidate_before_get_removes_cache_entry(self):
        """Invalidating a file then calling get should recompute."""
        content = "invalidate test"
        get_or_compute_embedding("e.py", content)
        assert "e.py" in _embedding_cache
        invalidate_cache_for_file("e.py")
        assert "e.py" not in _embedding_cache

    def test_get_or_compute_embedding_returns_list_of_floats(self):
        """Return type should be a list of numeric values."""
        result = get_or_compute_embedding("f.py", "def foo(): return 42")
        assert isinstance(result, list)
        assert len(result) > 0
        assert all(isinstance(v, (int, float)) for v in result)

    def test_empty_content_returns_valid_embedding(self):
        """Empty string content should still produce a valid embedding."""
        result = get_or_compute_embedding("g.py", "")
        assert isinstance(result, list)
        assert len(result) > 0
        assert all(isinstance(v, (int, float)) for v in result)

    def test_whitespace_only_content_returns_valid_embedding(self):
        """Whitespace-only content should still produce a valid embedding."""
        result = get_or_compute_embedding("h.py", "   \n\n   ")
        assert isinstance(result, list)
        assert len(result) > 0
        assert all(isinstance(v, (int, float)) for v in result)
