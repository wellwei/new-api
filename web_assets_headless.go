//go:build headless

package main

import "github.com/QuantumNous/new-api/router"

func prepareWebAssets() router.WebAssets {
	// 明确选择 API-only，不能用空 HTML 冒充无前端构建。
	return router.WebAssets{APIOnly: true}
}
