// next/server 대체(미설치 환경 전용): NextResponse.json은 표준 Response.json과 같은 응답을 만든다
class NextResponse extends Response {
  static json(body, init) {
    return Response.json(body, init);
  }
}
exports.NextResponse = NextResponse;
