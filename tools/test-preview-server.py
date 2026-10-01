#!/usr/bin/env python3
"""Regression checks for stale demo responses. Uses only Python's stdlib."""
import http.client
import http.server
import importlib.util
import os
import threading
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location(
    'preview_server', os.path.join(os.path.dirname(__file__), 'preview-server.py')
)
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class QuietHandler(preview.Handler):
    def log_message(self, fmt, *args):
        pass


class PreviewServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, method='GET', headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            result = (response.status, dict(response.getheaders()), response.read())
        finally:
            connection.close()
        return result

    def assert_uncached(self, headers):
        self.assertIn('no-store', headers['Cache-Control'])
        self.assertEqual(headers['Pragma'], 'no-cache')
        self.assertEqual(headers['Expires'], '0')

    def test_root_redirects_to_current_demo_even_with_query(self):
        for path in ('/', '/?old=1', '/index.html', '/index.html?old=1'):
            with self.subTest(path=path):
                status, headers, body = self.request(path)
                self.assertEqual(status, 302)
                self.assertEqual(headers['Location'], '/demo/?v=' + preview.VERSION)
                self.assertEqual(body, b'')
                self.assert_uncached(headers)

    def test_html_and_assets_are_never_cacheable(self):
        for path in ('/demo/', '/demo/demo.css', '/common.js', '/content/overlay.js',
                     '/popup/popup.html', '/popup/popup.css', '/popup/popup.js',
                     '/demo/demo-popup-shim.js'):
            with self.subTest(path=path):
                status, headers, body = self.request(path + '?v=' + preview.VERSION)
                self.assertEqual(status, 200)
                self.assertTrue(body)
                self.assert_uncached(headers)

    def test_old_conditional_requests_get_fresh_files_not_304(self):
        conditions = (
            {'If-Modified-Since': 'Fri, 01 Jan 2100 00:00:00 GMT'},
            {'If-None-Match': '*'}
        )
        for path in ('/demo/', '/common.js', '/content/overlay.js',
                     '/popup/popup.html', '/popup/popup.js', '/demo/demo-popup-shim.js'):
            for conditional_headers in conditions:
                with self.subTest(path=path, condition=conditional_headers):
                    status, headers, body = self.request(path, headers=conditional_headers)
                    self.assertEqual(status, 200)
                    self.assertTrue(body)
                    self.assert_uncached(headers)

    def test_release_version_is_not_frozen_when_server_starts(self):
        latest = preview.current_version()
        with mock.patch.object(preview, 'VERSION', 'old-build'):
            status, headers, body = self.request('/')
            self.assertEqual(status, 302)
            self.assertEqual(headers['Location'], '/demo/?v=' + latest)

    def test_demo_and_popup_visibly_identify_the_current_build(self):
        for path in ('/demo/?v=old-build', '/popup/popup.html?demo=1&v=old-build'):
            with self.subTest(path=path):
                status, headers, body = self.request(path)
                self.assertEqual(status, 200)
                self.assertIn(('v' + preview.VERSION).encode(), body)
                self.assertIn(('?v=' + preview.VERSION).encode(), body)
                self.assert_uncached(headers)

    def test_head_uses_same_redirect_and_cache_policy(self):
        status, headers, body = self.request('/', method='HEAD')
        self.assertEqual(status, 302)
        self.assertEqual(headers['Location'], '/demo/?v=' + preview.VERSION)
        self.assertEqual(body, b'')
        self.assert_uncached(headers)
        status, headers, body = self.request('/demo/', method='HEAD')
        self.assertEqual(status, 200)
        self.assertEqual(body, b'')
        self.assert_uncached(headers)


if __name__ == '__main__':
    unittest.main(verbosity=2)
