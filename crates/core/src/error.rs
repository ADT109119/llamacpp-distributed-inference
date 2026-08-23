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
    error_type: &'a str,
    code: &'a str,
}

impl ApiError {
    pub fn body(&self) -> ErrorBody<'_> {
        ErrorBody {
            error: ErrorInner {
                message: &self.message,
                error_type: "invalid_request_error",
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
}
