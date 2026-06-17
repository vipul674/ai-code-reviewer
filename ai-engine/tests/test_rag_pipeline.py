import json
import os
import tempfile
import pytest

from embeddings import (
    _compute_content_hash,
    _embedding_cache,
    _cache_enabled,
    invalidate_cache_for_file,
    clear_embedding_cache,
    get_cache_stats,
)


def test_content_hash_changes_when_content_changes():
    hash1 = _compute_content_hash("hello world")
    hash2 = _compute_content_hash("hello world!")
    assert hash1 != hash2
    assert len(hash1) == 64


def test_content_hash_is_deterministic():
    hash1 = _compute_content_hash("same content")
    hash2 = _compute_content_hash("same content")
    assert hash1 == hash2


def test_content_hash_empty_string():
    h = _compute_content_hash("")
    assert isinstance(h, str)
    assert len(h) == 64


def test_clear_cache_empties_all_entries():
    _embedding_cache["file1.py"] = {"content_hash": "abc", "embedding": [0.1, 0.2]}
    _embedding_cache["file2.py"] = {"content_hash": "def", "embedding": [0.3, 0.4]}
    clear_embedding_cache()
    assert len(_embedding_cache) == 0


def test_invalidate_cache_removes_single_entry():
    _embedding_cache["test.py"] = {"content_hash": "abc", "embedding": [0.1, 0.2]}
    invalidate_cache_for_file("test.py")
    assert "test.py" not in _embedding_cache


def test_invalidate_cache_nonexistent_file_does_not_raise():
    invalidate_cache_for_file("nonexistent.py")


def test_cache_stats_returns_expected_keys():
    _embedding_cache.clear()
    _embedding_cache["a.py"] = {"content_hash": "x", "embedding": [0.5]}
    stats = get_cache_stats()
    assert "enabled" in stats
    assert "size" in stats
    assert "keys" in stats
    assert stats["enabled"] == _cache_enabled
    assert stats["size"] == 1
    assert "a.py" in stats["keys"]


class TestVectorStore:
    @pytest.fixture(autouse=True)
    def setup_method(self):
        import vectorstore as vs
        self.vs = vs
        self._orig_file = vs.VECTORS_FILE
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            f.write("[]")
            self.temp_path = f.name
        vs.VECTORS_FILE = self.temp_path
        vs._vectors = []
        yield
        vs.VECTORS_FILE = self._orig_file
        vs._vectors = []
        if os.path.exists(self.temp_path):
            os.unlink(self.temp_path)

    def test_add_vector(self):
        self.vs._load()
        self.vs.add_vector("src/main.py", "print('hello')", [0.1, 0.2, 0.3])
        stored = self.vs.get_all_vectors()
        assert len(stored) == 1
        assert stored[0]["file_path"] == "src/main.py"
        assert stored[0]["embedding"] == [0.1, 0.2, 0.3]

    def test_add_vector_persists_to_disk(self):
        self.vs.add_vector("a.py", "content a", [1.0])
        with open(self.temp_path, "r") as f:
            data = json.load(f)
        assert len(data) == 1
        assert data[0]["file_path"] == "a.py"

    def test_delete_vectors_for_file(self):
        self.vs.add_vector("a.py", "content a", [1.0])
        self.vs.add_vector("b.py", "content b", [2.0])
        removed = self.vs.delete_vectors_for_file("a.py")
        assert removed == 1
        remaining = self.vs.get_all_vectors()
        assert len(remaining) == 1
        assert remaining[0]["file_path"] == "b.py"

    def test_delete_vectors_for_nonexistent_file(self):
        self.vs.add_vector("a.py", "content", [1.0])
        removed = self.vs.delete_vectors_for_file("nonexistent.py")
        assert removed == 0

    def test_cleanup_stale_vectors(self):
        self.vs.add_vector("keep.py", "keep", [1.0])
        self.vs.add_vector("stale.py", "stale", [2.0])
        self.vs.add_vector("also_stale.py", "also", [3.0])
        result = self.vs.cleanup_stale_vectors({"keep.py"})
        assert result["removed_count"] == 2
        assert "stale.py" in result["stale_paths"]
        assert "also_stale.py" in result["stale_paths"]
        remaining = self.vs.get_all_vectors()
        assert len(remaining) == 1
        assert remaining[0]["file_path"] == "keep.py"

    def test_cleanup_with_empty_current_files_removes_all(self):
        self.vs.add_vector("a.py", "a", [1.0])
        self.vs.add_vector("b.py", "b", [2.0])
        result = self.vs.cleanup_stale_vectors(set())
        assert result["removed_count"] == 2
        assert result["remaining_count"] == 0

    def test_cleanup_with_all_current_files_removes_none(self):
        self.vs.add_vector("a.py", "a", [1.0])
        self.vs.add_vector("b.py", "b", [2.0])
        result = self.vs.cleanup_stale_vectors({"a.py", "b.py"})
        assert result["removed_count"] == 0

    def test_get_vectors_for_file(self):
        self.vs.add_vector("a.py", "a", [1.0])
        self.vs.add_vector("a.py", "a v2", [1.5])
        self.vs.add_vector("b.py", "b", [2.0])
        file_vectors = self.vs.get_vectors_for_file("a.py")
        assert len(file_vectors) == 2
        for v in file_vectors:
            assert v["file_path"] == "a.py"

    def test_clear_all_vectors(self):
        self.vs.add_vector("a.py", "a", [1.0])
        self.vs.add_vector("b.py", "b", [2.0])
        count = self.vs.clear_all_vectors()
        assert count == 2
        assert len(self.vs.get_all_vectors()) == 0

    def test_vector_has_content_hash(self):
        self.vs.add_vector("a.py", "hello world", [0.5, 0.5])
        stored = self.vs.get_all_vectors()
        assert "content_hash" in stored[0]
        assert stored[0]["content_hash"] == _compute_content_hash("hello world")
