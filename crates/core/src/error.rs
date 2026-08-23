use serde::Serialize;

/// OpenAI 風格錯誤 body（對齊現行代理回應格式）
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

#[derive(Serialize)]
pub struct ErrorBody<'a> {
    error: ErrorInner<'a>,
}

#[derive(Serialize)]
pub struct ErrorInner<'a> {
    message: &'a str,
    #[serde(rename = "type")]
    #[serde(skip_serializing_if = "Option::is_none")]
    error_type: Option<&'static str>,
    code: &'a str,
}

impl ApiError {
    fn error_type(&self) -> Option<&'static str> {
        match self.status {
            503 => Some("service_unavailable"),
            502 => None,
            _ => Some("invalid_request_error"),
        }
    }

    pub fn body(&self) -> ErrorBody<'_> {
        ErrorBody {
            error: ErrorInner {
                message: &self.message,
                error_type: self.error_type(),
                code: self.code,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_api_error_json_shape() {
        let err = ApiError {
            status: 404,
            code: "model_not_found",
            message: "找不到".into(),
        };
        let json = serde_json::to_value(err.body()).unwrap();
        assert_eq!(json["error"]["type"], "invalid_request_error");
        assert_eq!(json["error"]["code"], "model_not_found");
        assert_eq!(json["error"]["message"], "找不到");
    }

    #[test]
    fn test_api_error_type_by_status() {
        let e503 = ApiError {
            status: 503,
            code: "no_active_model",
            message: "x".into(),
        };
        assert_eq!(
            serde_json::to_value(e503.body()).unwrap()["error"]["type"],
            "service_unavailable"
        );
        let e502 = ApiError {
            status: 502,
            code: "bad_gateway",
            message: "x".into(),
        };
        let json = serde_json::to_value(e502.body()).unwrap();
        assert!(json["error"].get("type").is_none());
    }
}
